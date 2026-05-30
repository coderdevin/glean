/**
 * Ingest pipeline. One submission flows through two stages with independent
 * retry boundaries:
 *
 *   stage A — processExtract: fetch URL (or use cache) → write raw text to R2
 *                              → DB rawR2Key. Cheap retry on network failure.
 *
 *   stage B — processLlm:     read raw from R2 → call DeepSeek/OpenAI →
 *                              parse → DB ai_* fields. Skipped on no-retry
 *                              schema failures (don't burn tokens twice).
 *
 * Each stage runs in its own Cloudflare Queue worker:
 *   workers/ingest-consumer  → glean-ingest queue → processExtract
 *   workers/llm-consumer     → glean-llm queue    → processLlm
 *
 * On extract success the first worker forwards the id via env.INGEST_LLM.send().
 * Other entry points (admin paste, admin re-run LLM) can also enqueue directly
 * to glean-llm, skipping the extract stage when R2 already has content.
 */

import { and, eq, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import {
  submissions,
  submissionEvents,
  picks,
  pickTags,
  tags as tagsTable,
  type EventStage,
  type EventStatus,
} from "~/db/schema";
import { callLlmAnalysis, callLlmSections, NO_RETRY_MARKER, type LlmEnv } from "./llm";
import { extractFromUrl } from "./extract";
import { bustForPick } from "./cache";
import { ulid } from "./ulid";

export interface IngestEnv extends LlmEnv {
  DB: D1Database;
  RAW: R2Bucket;
  /** Optional. Lifts Jina Reader (Tier 3 extract fallback) past the
   *  anonymous 20 req/min cap. Set with `wrangler secret put JINA_API_KEY`. */
  JINA_API_KEY?: string;
  /** Optional KV cache. runSectionsPhase invalidates pick-level cache keys
   *  when regenerating sections on an already-published row. Workers that
   *  don't bind CACHE just skip the bust — admin sees stale content until
   *  the KV TTL expires. */
  CACHE?: KVNamespace;
}

export interface ExtractEnv extends IngestEnv {
  /** Producer binding for the LLM stage queue. The extract worker forwards
   *  here after a successful R2 write. Pages handlers also use it directly
   *  for paste / re-run flows that skip the extract stage. */
  INGEST_LLM: Queue<string>;
}

export interface ExtractResult {
  id: string;
  detectedLang: "zh" | "en" | "other";
  rawR2Key: string;
  bodyChars: number;
}

export interface LlmStageResult {
  id: string;
  status: "ready" | "composing";
  provider: string;
  model: string;
  latencyMs: number;
  totalTokens: number | null;
  reasoningChars: number;
  tagsKept: string[];
  tagsDropped: string[];
  /** True when analysis just completed and the sections phase still needs to
   *  run. The caller (queue worker) enqueues a separate `phase=sections`
   *  message so sections gets its OWN 15-min worker invocation rather than
   *  sharing analysis's — see the wall-time note in processLlm. */
  needsSections?: boolean;
}

export interface ProcessLlmOptions {
  /** Override the LLM model for this one call (admin "重跑 V4-Pro / V4-Flash"
   *  button). Suppresses LLM_FALLBACK_MODEL — explicit choice wins. */
  modelOverride?: string;
}

const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEFAULT_DEEPSEEK_SECTIONS_MODEL = "deepseek-v4-flash";

export function defaultSectionsModel(modelOverride?: string): string {
  return modelOverride ?? DEFAULT_DEEPSEEK_SECTIONS_MODEL;
}

/**
 * Append one row to the submission_events log. Best-effort: a failure here
 * never breaks the pipeline — the underlying status writes on submissions
 * remain the source of truth.
 */
export async function logEvent(
  env: { DB: D1Database },
  submissionId: string,
  stage: EventStage,
  status: EventStatus,
  opts: { message?: string; meta?: Record<string, unknown> } = {},
): Promise<void> {
  // Mirror to console BEFORE the DB insert so `wrangler tail` always sees the
  // intent — even if D1 transients silently swallow the row, we can still
  // reconstruct the timeline from worker logs.
  console.log(`event ${stage}/${status} sub=${submissionId}${opts.message ? ` — ${opts.message.slice(0, 120)}` : ""}`);
  try {
    const db = drizzle(env.DB, { schema });
    await db.insert(submissionEvents).values({
      id: ulid(),
      submissionId,
      stage,
      status,
      message: opts.message ? opts.message.slice(0, 500) : null,
      metaJson: opts.meta ? JSON.stringify(opts.meta) : null,
      createdAt: new Date(),
    });
  } catch (err) {
    // Loud failure — previous `console.warn` was easy to miss. The timeline
    // panel relies entirely on this table; a silent drop loses ground truth.
    console.error("logEvent INSERT failed (event lost — timeline panel will be incomplete)", {
      submissionId,
      stage,
      status,
      message: opts.message?.slice(0, 200),
      err: (err as Error).message,
      stack: (err as Error).stack?.split("\n").slice(0, 3).join(" | "),
    });
  }
}
const modelFromRow = (model: string | null): string | null =>
  model && model !== "extract" ? model : null;

/**
 * Stage A: fetch / cache-load the article body, stash in R2, update D1.
 * Does NOT call the LLM. Returns enough info for the worker to log + forward.
 */
export async function processExtract(env: IngestEnv, id: string): Promise<ExtractResult> {
  const db = drizzle(env.DB, { schema });

  await db
    .update(submissions)
    .set({ status: "analyzing", processingStartedAt: new Date(), processingModel: "extract" })
    .where(eq(submissions.id, id));
  await logEvent(env, id, "extract", "started");

  const sRows = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const row = sRows[0];
  if (!row) throw new Error(`submission ${id} not found`);

  // Cache short-circuit — if R2 already has a body from a prior extract /
  // a paste flow, reuse it instead of refetching. /refetch clears rawR2Key
  // to force a fresh fetch.
  let body: { textContent: string; detectedLang: "zh" | "en" | "other"; title: string } | null = null;
  let cached = false;
  if (row.rawR2Key) {
    const obj = await env.RAW.get(row.rawR2Key);
    if (obj) {
      const text = await obj.text();
      if (text.length >= 200) {
        body = {
          textContent: text,
          detectedLang: detectLangSimple(text),
          // Title was stashed in R2 customMetadata on the original extract.
          title: obj.customMetadata?.title || "",
        };
        cached = true;
      }
    }
  }
  if (!body) {
    const extracted = await extractFromUrl(row.url, { jinaApiKey: env.JINA_API_KEY });
    body = {
      textContent: extracted.textContent,
      detectedLang: extracted.detectedLang,
      title: extracted.title || "",
    };
  }

  const rawKey = `raw/${id}.txt`;
  await env.RAW.put(rawKey, body.textContent, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    // Preserve the extracted HTML <title> on the R2 object so the LLM stage
    // can read it without re-fetching the URL. Without this, processLlm
    // would seed callLlm with row.url (slug-shaped) and LLM titles regress.
    customMetadata: {
      url: row.url,
      detectedLang: body.detectedLang,
      title: body.title.slice(0, 256),
    },
  });
  await db
    .update(submissions)
    .set({ rawR2Key: rawKey, extractedLang: body.detectedLang })
    .where(eq(submissions.id, id));
  await logEvent(env, id, "extract", "ok", {
    meta: {
      chars: body.textContent.length,
      lang: body.detectedLang,
      cached,
    },
  });

  return {
    id,
    detectedLang: body.detectedLang,
    rawR2Key: rawKey,
    bodyChars: body.textContent.length,
  };
}

/**
 * Stage B: read raw body from R2 (must be already extracted), call the LLM,
 * parse, write ai_* fields and flip status to 'ready'. Throws if rawR2Key
 * is missing — caller should ensure extract ran first.
 */
export async function processLlm(
  env: IngestEnv,
  id: string,
  opts: ProcessLlmOptions = {},
): Promise<LlmStageResult> {
  const db = drizzle(env.DB, { schema });

  const sRows = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const row = sRows[0];
  if (!row) throw new Error(`submission ${id} not found`);
  if (!row.rawR2Key) {
    throw new Error(`submission ${id} has no rawR2Key — run extract stage first`);
  }
  // Idempotency guard: if the row is already in a terminal good state, skip
  // the LLM call. Visibility-timeout redeliveries used to re-run the model
  // (wasting tokens) and could race the original delivery's status write.
  // The admin "re-run" endpoint resets status to `pending` before enqueueing
  // an explicit rerun, so this guard doesn't block intentional reruns.
  if (row.status === "composing" || row.status === "ready" || row.status === "published") {
    await logEvent(env, id, "llm", "skipped", {
      message: "already in terminal state",
      meta: { status: row.status },
    });
    return {
      id,
      status: "ready",
      provider: row.aiModel?.split("/")[0] ?? "skipped",
      model: row.aiModel?.split("/")[1] ?? "skipped",
      latencyMs: row.aiLatencyMs ?? 0,
      totalTokens: row.aiTokens ?? 0,
      reasoningChars: 0,
      tagsKept: row.aiTagsJson ? (JSON.parse(row.aiTagsJson) as string[]) : [],
      tagsDropped: [],
      needsSections: false,
    };
  }
  const obj = await env.RAW.get(row.rawR2Key);
  if (!obj) {
    throw new Error(`R2 object ${row.rawR2Key} missing — extract stage must rerun`);
  }
  const body = await obj.text();
  if (body.length < 200) {
    throw new Error(`R2 body too short (${body.length} < 200) — extract stage must rerun`);
  }
  // Title preference: explicit override on submission (set by /paste with a
  // manual title) > customMetadata.title stamped at extract time > row.url.
  const titleSeed =
    row.aiTitleEn?.trim() || obj.customMetadata?.title?.trim() || row.url;

  const processingModel =
    opts.modelOverride ?? modelFromRow(row.processingModel) ?? row.aiModel?.split("/")[1] ?? DEFAULT_DEEPSEEK_MODEL;
  await db
    .update(submissions)
    .set({ status: "analyzing", processingStartedAt: new Date(), processingModel })
    .where(eq(submissions.id, id));
  // One "started" per processLlm invocation. Phase boundaries are visible
  // via the "analysis phase ok" / "sections phase ok|failed" events below —
  // emitting a second "started" for each phase clutters the timeline without
  // adding information.
  await logEvent(env, id, "llm", "started", {
    meta: { model: processingModel, body_chars: body.length },
  });

  const taxonomyRows = await db.select({ slug: tagsTable.slug }).from(tagsTable);
  const taxonomy = taxonomyRows.map((t) => t.slug);

  const sourceHost = (() => {
    try { return new URL(row.url).host; } catch { return undefined; }
  })();
  const submittedDate = row.createdAt
    ? new Date(row.createdAt).toISOString().slice(0, 10)
    : undefined;

  // Phase 1: analysis. Failure here is the same as the old single call —
  // propagate and let the queue worker handle retry/no-retry.
  console.log(`processLlm ${id}: phase 1 (analysis) starting model=${processingModel} body_chars=${body.length}`);
  const analysis = await callLlmAnalysis(env, {
    title: titleSeed,
    body,
    taxonomy,
    modelOverride: opts.modelOverride,
    submissionId: id,
    sourceHost,
    submitterNote: row.note ?? undefined,
    submittedDate,
  });

  console.log(`processLlm ${id}: phase 1 done latency=${analysis.latencyMs}ms tokens=${analysis.totalTokens ?? "?"}`);
  const taxonomySet = new Set(taxonomy);
  const tagsKept = analysis.output.tags.filter((t) => taxonomySet.has(t)).slice(0, 3);
  const tagsDropped = analysis.output.tags.filter((t) => !taxonomySet.has(t));

  await db
    .update(submissions)
    .set({
      status: "composing",
      aiTitleZh: analysis.output.title_zh,
      aiTitleEn: analysis.output.title_en,
      aiSummaryZh: analysis.output.summary_zh,
      aiSummaryEn: analysis.output.summary_en,
      aiBulletsJson: JSON.stringify(analysis.output.bullets),
      // Do NOT wipe aiSectionsJson here. On a re-run of a previously-good
      // row, the existing sections stay in place until phase 2 finishes;
      // if phase 2 then fails the row goes to 'failed' (not 'ready'), so it
      // still can't publish, but the old sections aren't destroyed.
      aiSectionsError: null,
      aiTagsJson: JSON.stringify(tagsKept),
      aiCategory: analysis.output.category,
      aiScore: analysis.output.score,
      aiSubscoresJson: analysis.output.subscores ? JSON.stringify(analysis.output.subscores) : null,
      aiGlossaryJson: analysis.output.glossary.length ? JSON.stringify(analysis.output.glossary) : null,
      aiNextHintsJson: analysis.output.next_hints.length ? JSON.stringify(analysis.output.next_hints) : null,
      aiModel: `${analysis.provider.name}/${analysis.provider.model}`,
      aiLatencyMs: analysis.latencyMs,
      aiTokens: analysis.totalTokens,
      processingModel: null,
      processedAt: new Date(),
      rejectReason: null,
    })
    .where(eq(submissions.id, id));
  await logEvent(env, id, "llm", "ok", {
    message: "analysis phase ok",
    meta: {
      phase: "analysis",
      provider: analysis.provider.name,
      model: analysis.provider.model,
      latency_ms: analysis.latencyMs,
      tokens: analysis.totalTokens,
      tags_kept: tagsKept,
      tags_dropped: tagsDropped,
    },
  });

  // Phase 2 (sections) runs in its OWN queue invocation, NOT inline here.
  // Analysis + sections in a single worker can exceed Cloudflare's 15-minute
  // queue-consumer wall-time ceiling (sections alone budgets up to 14min); the
  // platform then evicts the worker mid-run, bypassing every try/catch, so no
  // failure is ever recorded and the row strands in 'composing'. Instead we
  // stop after analysis (status already 'composing') and signal the caller to
  // enqueue a `phase=sections` message, giving sections a fresh 15-min budget.
  return {
    id,
    status: "composing",
    provider: analysis.provider.name,
    model: analysis.provider.model,
    latencyMs: analysis.latencyMs,
    totalTokens: analysis.totalTokens,
    reasoningChars: analysis.reasoningChars,
    tagsKept,
    tagsDropped,
    needsSections: true,
  };
}

/**
 * A submission is "stalled" if it has sat in an in-flight state
 * (`analyzing`/`composing`) longer than the worker could possibly run. A
 * Cloudflare queue consumer is killed at a 15-minute wall-time ceiling; an
 * external kill bypasses the in-worker try/catch, so the row never records a
 * failure on its own. The reaper (below) sweeps these into `failed`.
 */
export const STALL_WINDOW_MS = 20 * 60_000;

export function isStaleLlmQueueWait(
  status: string,
  rawR2Key: string | null | undefined,
  processingModel: string | null | undefined,
  processingStartedAt: Date | null | undefined,
  now: Date,
  windowMs: number = STALL_WINDOW_MS,
): boolean {
  if (!rawR2Key || !processingStartedAt) return false;
  const waitingForLlm =
    status === "pending" ||
    (status === "analyzing" && processingModel === "extract");
  if (!waitingForLlm) return false;
  return now.getTime() - processingStartedAt.getTime() > windowMs;
}

export function isStalledInFlight(
  status: string,
  processingStartedAt: Date | null | undefined,
  now: Date,
  windowMs: number = STALL_WINDOW_MS,
  processingModel?: string | null,
  rawR2Key?: string | null,
): boolean {
  if (status !== "analyzing" && status !== "composing") return false;
  if (!processingStartedAt) return false;
  // Extract has finished and forwarded the row to glean-llm, but the LLM
  // worker has not started yet. That is queue wait, not a stalled worker run.
  if (status === "analyzing" && processingModel === "extract" && rawR2Key) return false;
  return now.getTime() - processingStartedAt.getTime() > windowMs;
}

/**
 * Mark rows that have extracted raw text but never reached the LLM worker.
 * This is distinct from `reapStalledSubmissions`: queue wait is not a worker
 * eviction, and retrying blindly can duplicate expensive LLM calls. Fail with
 * a precise reason so admin can intentionally re-run.
 */
export async function reapStaleLlmQueueWait(
  env: { DB: D1Database },
  now: Date = new Date(),
): Promise<number> {
  const db = drizzle(env.DB, { schema });
  const cutoff = new Date(now.getTime() - STALL_WINDOW_MS);
  const message = `LLM queue wait exceeded ${STALL_WINDOW_MS / 60_000}min — the queue message may not have been delivered; re-run from the admin UI`;
  const reaped = await db
    .update(submissions)
    .set({
      status: "failed",
      failureStage: "analysis",
      aiSectionsError: message,
      processedAt: now,
    })
    .where(
      and(
        isNotNull(submissions.rawR2Key),
        isNotNull(submissions.processingStartedAt),
        lt(submissions.processingStartedAt, cutoff),
        sql`(${submissions.status} = 'pending' OR (${submissions.status} = 'analyzing' AND COALESCE(${submissions.processingModel}, '') = 'extract'))`,
      ),
    )
    .returning({ id: submissions.id });
  for (const r of reaped) {
    await logEvent(env, r.id, "pipeline", "failed", {
      message,
      meta: { source: "llm-queue-watchdog" },
    });
  }
  return reaped.length;
}

/**
 * Reap stalled in-flight submissions: flip rows stuck in `analyzing`/`composing`
 * past STALL_WINDOW_MS to `failed` with an explanatory error, so the admin UI
 * stops showing a perpetual "running…" timer and the editor can re-run. Run from
 * the worker's scheduled (cron) handler. Returns the number reaped.
 */
export async function reapStalledSubmissions(
  env: { DB: D1Database },
  now: Date = new Date(),
): Promise<number> {
  const db = drizzle(env.DB, { schema });
  const cutoff = new Date(now.getTime() - STALL_WINDOW_MS);
  const reaped = await db
    .update(submissions)
    .set({
      status: "failed",
      // pre-update status decides the stage: composing → sections, else analysis.
      failureStage: sql`CASE WHEN ${submissions.status} = 'composing' THEN 'sections' ELSE 'analysis' END`,
      aiSectionsError: `pipeline stalled past ${STALL_WINDOW_MS / 60_000}min — the worker was likely evicted before it could record an error; re-run from the admin UI`,
      processedAt: now,
    })
    .where(
      and(
        inArray(submissions.status, ["analyzing", "composing"]),
        isNotNull(submissions.processingStartedAt),
        lt(submissions.processingStartedAt, cutoff),
        sql`NOT (${submissions.status} = 'analyzing' AND COALESCE(${submissions.processingModel}, '') = 'extract' AND ${submissions.rawR2Key} IS NOT NULL)`,
      ),
    )
    .returning({ id: submissions.id });
  for (const r of reaped) {
    await logEvent(env, r.id, "pipeline", "failed", {
      message: `reaped: stalled in-flight past ${STALL_WINDOW_MS / 60_000}min (worker likely evicted)`,
      meta: { source: "reaper" },
    });
  }
  return reaped.length;
}

interface SectionsRunArgs {
  id: string;
  title: string;
  body: string;
  detectedLang?: "zh" | "en" | "other";
  sourceHost?: string;
  submitterNote?: string;
  submittedDate?: string;
  modelOverride?: string;
}

interface SectionsRunResult {
  status: "ok" | "failed";
  error?: string;
  latencyMs?: number;
  tokens?: number | null;
  reasoningChars?: number;
}

/**
 * Phase 2 of processLlm. Also reused by the admin "regenerate sections"
 * endpoint (via the llm-consumer worker — never invoked synchronously from
 * a Pages SSR route, which would hit the 30s wall-time limit).
 *
 * Writes aiSectionsJson and advances status (ready | failed). Logs one
 * "ok" or "failed" event at completion. Does NOT log "started" — phase 1's
 * "llm started" event already marks the run; one start per processLlm
 * invocation is enough.
 *
 * Never throws. With max_retries=0 on the queue, any throw would be lost
 * silently; catching here guarantees the row state always reflects what
 * actually happened.
 *
 * For rows already in 'published' state (admin requested a sections rebuild
 * after the article shipped), also updates picks.sectionsJson and busts the
 * KV cache so readers see the new body.
 */
export async function runSectionsPhase(
  env: IngestEnv,
  args: SectionsRunArgs,
): Promise<SectionsRunResult> {
  const db = drizzle(env.DB, { schema });
  // One "started" so the timeline shows the phase entered. Without this the
  // log goes silent for the 2–4 minutes V4-Pro spends on sections and the
  // editor can't tell whether anything is happening. (We dropped the inline
  // dual-started events earlier; this is the surviving one per phase.)
  const sectionsModel = defaultSectionsModel(args.modelOverride);
  // Reset the stall clock to NOW. The reaper measures staleness from
  // processing_started_at; sections runs in its own invocation (decoupled
  // pipeline) or hours after analysis (admin regenerate), so without this the
  // row carries a stale timestamp and the cron reaps the fresh run within
  // minutes. Stamp it at sections-start so the 20-min window is accurate.
  await db
    .update(submissions)
    .set({ processingStartedAt: new Date() })
    .where(eq(submissions.id, args.id));
  await logEvent(env, args.id, "llm", "started", {
    message: "sections phase",
    meta: { phase: "sections", model: sectionsModel, body_chars: args.body.length },
  });
  try {
    const sections = await callLlmSections(env, {
      title: args.title,
      body: args.body,
      detectedLang: args.detectedLang,
      modelOverride: sectionsModel,
      submissionId: args.id,
      sourceHost: args.sourceHost,
      submitterNote: args.submitterNote,
      submittedDate: args.submittedDate,
    });
    // Empty after the post-filter in callLlmSections means every section
    // came back blank — typically a silent truncation the JSON parser
    // didn't catch. Treat as failure, not as "successful empty body".
    if (sections.output.sections.length === 0) {
      const msg = `${NO_RETRY_MARKER} sections phase produced 0 valid sections (likely truncation or all-empty bodies)`;
      throw new Error(msg);
    }
    const sectionsJson = JSON.stringify(sections.output.sections);
    // Persist the new sections + clear any prior failure marker.
    await db
      .update(submissions)
      .set({ aiSectionsJson: sectionsJson, failureStage: null, aiSectionsError: null })
      .where(eq(submissions.id, args.id));
    // Promote composing → ready, but NEVER downgrade an already-published row
    // that is merely regenerating its body.
    await db
      .update(submissions)
      .set({ status: "ready" })
      .where(and(eq(submissions.id, args.id), ne(submissions.status, "published")));
    // If admin regenerated sections on an already-published row, the public
    // article page reads picks.sectionsJson (not submissions), so we have
    // to update that too — and bust the cache.
    const subRow = await db
      .select({
        status: submissions.status,
        linkedPickId: submissions.linkedPickId,
      })
      .from(submissions)
      .where(eq(submissions.id, args.id))
      .limit(1);
    if (subRow[0]?.status === "published" && subRow[0]?.linkedPickId) {
      await db
        .update(picks)
        .set({ sectionsJson })
        .where(eq(picks.id, subRow[0].linkedPickId));
      if (env.CACHE) {
        const pickRow = await db
          .select({
            slug: picks.slug,
            dailyDate: picks.dailyDate,
            weeklyIssueId: picks.weeklyIssueId,
          })
          .from(picks)
          .where(eq(picks.id, subRow[0].linkedPickId))
          .limit(1);
        if (pickRow[0]) {
          const tagSlugs = await db
            .select({ tagSlug: pickTags.tagSlug })
            .from(pickTags)
            .where(eq(pickTags.pickId, subRow[0].linkedPickId));
          await bustForPick(
            env.CACHE,
            {
              slug: pickRow[0].slug,
              dailyDate: pickRow[0].dailyDate,
              weeklyIssueId: pickRow[0].weeklyIssueId,
            },
            tagSlugs.map((t) => t.tagSlug),
          ).catch((e) => console.warn("bustForPick failed (ignored)", e));
        }
      }
    }
    await logEvent(env, args.id, "llm", "ok", {
      message: "sections phase ok",
      meta: {
        phase: "sections",
        provider: sections.provider.name,
        model: sections.provider.model,
        latency_ms: sections.latencyMs,
        tokens: sections.totalTokens,
        section_count: sections.output.sections.length,
      },
    });
    return {
      status: "ok",
      latencyMs: sections.latencyMs,
      tokens: sections.totalTokens,
      reasoningChars: sections.reasoningChars,
    };
  } catch (err) {
    const msg = (err as Error).message;
    const noRetry = msg.startsWith(NO_RETRY_MARKER);
    await db
      .update(submissions)
      .set({
        status: "failed",
        failureStage: "sections",
        aiSectionsError: msg.slice(0, 500),
      })
      .where(and(eq(submissions.id, args.id), ne(submissions.status, "published")));
    await logEvent(env, args.id, "llm", "failed", {
      message: msg.slice(0, 500),
      meta: { phase: "sections", no_retry: noRetry },
    });
    return { status: "failed", error: msg };
  }
}

/** Cheap lang detect for the no-DOM path (R2 cache, paste). */
function detectLangSimple(text: string): "zh" | "en" | "other" {
  const sample = text.slice(0, 500);
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > latin * 0.3) return "zh";
  if (latin > cjk * 2) return "en";
  return "other";
}

/** @deprecated No longer called — AI failures use markFailed; editor rejects write the row directly in reject.ts. Kept for now. */
/**
 * Mark a submission rejected after a fatal ingest error. Called by either
 * queue worker's catch handler once retries are exhausted (or skipped on a
 * deterministic no-retry failure).
 *
 * Guarded: never downgrade a row that already reached `ready` or
 * `published`. Without this guard, a late/failing duplicate delivery
 * (caused by visibility-timeout redelivery during a long LLM call) would
 * overwrite a successful run's status with `rejected` even though the AI
 * fields were already populated — the row would appear fully parsed yet
 * stuck in REJECTED in the admin UI.
 */
export async function markRejected(
  env: { DB: D1Database },
  id: string,
  reason: string,
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const result = await db
    .update(submissions)
    .set({
      status: "rejected",
      rejectReason: reason.slice(0, 200),
      processingModel: null,
      processedAt: new Date(),
    })
    .where(
      and(
        eq(submissions.id, id),
        notInArray(submissions.status, ["ready", "published"]),
      ),
    )
    .returning({ id: submissions.id });
  if (result.length > 0) {
    await logEvent(env, id, "pipeline", "rejected", {
      message: reason.slice(0, 500),
    });
  }
}

/**
 * Mark a submission failed after an AI-pipeline error (extract/analysis/
 * sections). Distinct from editor `rejected`. Guarded so a late duplicate
 * delivery never downgrades a row already in `ready`/`published`.
 */
export async function markFailed(
  env: { DB: D1Database },
  id: string,
  stage: "extract" | "analysis" | "sections",
  reason: string,
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const result = await db
    .update(submissions)
    .set({
      status: "failed",
      failureStage: stage,
      aiSectionsError: reason.slice(0, 500),
      processingModel: null,
      processedAt: new Date(),
    })
    .where(
      and(
        eq(submissions.id, id),
        notInArray(submissions.status, ["ready", "published"]),
      ),
    )
    .returning({ id: submissions.id });
  if (result.length > 0) {
    await logEvent(env, id, "pipeline", "failed", { message: reason.slice(0, 500) });
  }
}
