/**
 * Glean LLM-stage worker.
 *
 * Consumes the `glean-llm` queue. Two message shapes:
 *
 *   "<ULID>"                           full pipeline: processLlm runs
 *                                      analysis + sections inline
 *   "<ULID>|model=<name>"              same, with admin model override
 *   "<ULID>|phase=sections"            sections-only retry from admin UI
 *   "<ULID>|phase=sections&model=..."  sections-only with model override
 *   "<ULID>|kind=weekly"               weekly-issue draft (generate / regenerate)
 *
 * Failure semantics (max_retries=0 on the queue):
 *   - Any error from processLlm (analysis phase) → markFailed + ack.
 *     Admin's "Re-run V4-Pro" is the human-driven retry; the queue does
 *     not auto-retry.
 *   - runSectionsPhase catches its own errors and sets status='failed'
 *     on the row — it never throws. For the
 *     sections-only path that means we just ack after it returns.
 *
 * Two entry points: queue() (prod) and fetch() (dev manual trigger).
 */

import {
  processLlm,
  runSectionsPhase,
  runWeeklyDraft,
  markFailed,
  reapStaleLlmQueueWait,
  reapStalledSubmissions,
  reapStalledWeeklyDrafts,
  logEvent,
  type IngestEnv,
} from "../../../src/lib/ingest";
import { NO_RETRY_MARKER } from "../../../src/lib/llm";
import { runWikiBuild } from "../../../src/lib/wiki";
import { getLlmProviderSetting, withLlmProviderSetting } from "../../../src/lib/settings";
import { autoPublishReady } from "../../../src/lib/publish";

/** Daily auto-publish cron: 22:00 UTC = 06:00 Asia/Shanghai. Publishes the
 *  newest 3 'ready' submissions (most recently added first) so the editor
 *  doesn't have to each morning. */
const DAILY_PUBLISH_CRON = "0 22 * * *";
const DAILY_PUBLISH_COUNT = 3;
import { drizzle } from "drizzle-orm/d1";
import { asc, eq, inArray, isNotNull, and } from "drizzle-orm";
import { submissions } from "../../../src/db/schema";

export interface Env extends IngestEnv {
  /** Producer binding for the same queue — used by sections-only retries
   *  enqueued from the regenerate-sections Pages route. Declared here so
   *  the worker can also self-enqueue if that pattern ever becomes useful;
   *  currently only the Pages side calls it. */
  INGEST_LLM: Queue<string>;
}

function parseMessage(raw: string): {
  id: string;
  modelOverride?: string;
  phase?: "sections";
  kind?: "weekly" | "wiki";
  mode?: "full" | "incremental";
} {
  const pipeIdx = raw.indexOf("|");
  const id = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
  const tail = pipeIdx >= 0 ? raw.slice(pipeIdx + 1) : "";
  const modelMatch = tail.match(/(?:^|&)model=([^&]+)/);
  const phaseMatch = tail.match(/(?:^|&)phase=([^&]+)/);
  const kindMatch = tail.match(/(?:^|&)kind=([^&]+)/);
  const modeMatch = tail.match(/(?:^|&)mode=([^&]+)/);
  // Trim before truthy-check so whitespace-only values (`model=%20`) fall
  // through to the env default instead of producing an invalid model name.
  const trimmed = modelMatch ? decodeURIComponent(modelMatch[1]!).trim() : "";
  const phaseRaw = phaseMatch ? decodeURIComponent(phaseMatch[1]!).trim() : "";
  const kindRaw = kindMatch ? decodeURIComponent(kindMatch[1]!).trim() : "";
  const modeRaw = modeMatch ? decodeURIComponent(modeMatch[1]!).trim() : "";
  return {
    id,
    modelOverride: trimmed || undefined,
    phase: phaseRaw === "sections" ? "sections" : undefined,
    kind: kindRaw === "weekly" ? "weekly" : kindRaw === "wiki" ? "wiki" : undefined,
    // Wiki-only. Unknown/absent → "full" at the call site (back-compat with
    // messages already in flight when this deployed).
    mode: modeRaw === "incremental" ? "incremental" : modeRaw === "full" ? "full" : undefined,
  };
}

async function runSectionsOnly(env: Env, id: string, modelOverride?: string): Promise<void> {
  const db = drizzle(env.DB);
  const sRows = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const sub = sRows[0];
  if (!sub) {
    await logEvent(env, id, "llm", "failed", {
      message: `submission ${id} not found`,
      meta: { phase: "sections", source: "sections-only" },
    });
    return;
  }
  if (!sub.rawR2Key) {
    await logEvent(env, id, "llm", "failed", {
      message: `submission ${id} has no rawR2Key — extract first`,
      meta: { phase: "sections", source: "sections-only" },
    });
    return;
  }
  const obj = await env.RAW.get(sub.rawR2Key);
  if (!obj) {
    await logEvent(env, id, "llm", "failed", {
      message: `R2 object ${sub.rawR2Key} missing — refetch required`,
      meta: { phase: "sections", source: "sections-only" },
    });
    return;
  }
  const body = await obj.text();
  if (body.length < 200) {
    await logEvent(env, id, "llm", "failed", {
      message: `R2 body too short (${body.length} chars)`,
      meta: { phase: "sections", source: "sections-only" },
    });
    return;
  }
  const titleSeed =
    sub.aiTitleEn?.trim() || obj.customMetadata?.title?.trim() || sub.url;
  const sourceHost = (() => {
    try { return new URL(sub.url).host; } catch { return undefined; }
  })();
  const submittedDate = sub.createdAt
    ? new Date(sub.createdAt).toISOString().slice(0, 10)
    : undefined;
  const detectedLang: "zh" | "en" | "other" | undefined =
    sub.extractedLang === "zh" || sub.extractedLang === "en" || sub.extractedLang === "other"
      ? sub.extractedLang
      : undefined;
  // runSectionsPhase is non-throwing; it sets status (ready|failed) itself.
  await runSectionsPhase(env, {
    id,
    title: titleSeed,
    body,
    detectedLang,
    sourceHost,
    submitterNote: sub.note ?? undefined,
    submittedDate,
    modelOverride,
  });
}

export default {
  async queue(batch: MessageBatch<string>, rawEnv: Env): Promise<void> {
    // Apply the persisted default-provider toggle once per batch so every
    // LLM call in this invocation honors it (admin can flip ModelScope ↔
    // DeepSeek without a redeploy). Per-message model overrides still win.
    const env = withLlmProviderSetting(rawEnv, await getLlmProviderSetting(rawEnv.DB));
    for (const msg of batch.messages) {
      const { id, modelOverride, phase, kind, mode } = parseMessage(msg.body);

      // Wiki index rebuild. runWikiBuild is non-throwing and writes its own
      // wiki_index row (rebuild publishes live), so we just ack regardless.
      if (kind === "wiki") {
        try {
          const result = await runWikiBuild(env, { mode: mode ?? "full" });
          console.log("wiki build", result);
        } catch (err) {
          const reason = (err as Error).message ?? "unknown wiki build error";
          console.error("wiki build fail", { reason });
          await logEvent(env, id, "llm", "failed", {
            message: reason,
            meta: { kind: "wiki", source: "wiki-throw" },
          });
        }
        msg.ack();
        continue;
      }

      // Weekly-issue draft. runWeeklyDraft is non-throwing and writes its own
      // terminal state (draft_status = 'ready' | 'failed') onto the issue row,
      // so we just ack regardless — same contract as the sections-only path.
      if (kind === "weekly") {
        try {
          const result = await runWeeklyDraft(env, id);
          console.log("weekly draft", { id, ...result });
        } catch (err) {
          // Defensive — runWeeklyDraft shouldn't throw, but if loading the
          // row blows up we still want to ack and log.
          const reason = (err as Error).message ?? "unknown weekly draft error";
          console.error("weekly draft fail", { id, reason });
          await logEvent(env, id, "llm", "failed", {
            message: reason,
            meta: { kind: "weekly", source: "weekly-throw" },
          });
        }
        msg.ack();
        continue;
      }

      // Sections-only retry path. runSectionsPhase swallows its own errors
      // and sets status='failed' on the row, so we just ack regardless. No
      // markFailed here — analysis already succeeded; only sections failed.
      if (phase === "sections") {
        try {
          await runSectionsOnly(env, id, modelOverride);
        } catch (err) {
          // Defensive — runSectionsPhase shouldn't throw, but if loading
          // the row / R2 blows up we still want to ack and log.
          const reason = (err as Error).message ?? "unknown sections-only error";
          console.error("sections-only fail", { id, reason });
          await logEvent(env, id, "llm", "failed", {
            message: reason,
            meta: { phase: "sections", source: "sections-only-throw" },
          });
        }
        msg.ack();
        continue;
      }

      // Analysis pass. Sections runs in its OWN invocation (enqueued below)
      // so it gets a fresh 15-min wall-time budget — running both inline can
      // exceed the CF queue-consumer ceiling and strand the row.
      try {
        const result = await processLlm(env, id, { modelOverride });
        console.log("llm ok", result);
        if (result.needsSections) {
          const sectionsMsg = modelOverride
            ? `${id}|phase=sections&model=${modelOverride}`
            : `${id}|phase=sections`;
          await env.INGEST_LLM.send(sectionsMsg);
        }
        msg.ack();
      } catch (err) {
        const reason = (err as Error).message ?? "unknown llm error";
        const deterministic = reason.includes(NO_RETRY_MARKER);
        console.error("llm fail", { id, reason, attempts: msg.attempts, deterministic });
        await logEvent(env, id, "llm", "failed", {
          message: reason,
          meta: { attempts: msg.attempts, deterministic, modelOverride },
        });
        // With max_retries=0 the queue never redelivers; every failure is
        // terminal. markFailed guards against downgrading rows already in
        // 'ready'/'published', so a sections-phase failure that somehow
        // bubbled to this path won't clobber a successful analysis.
        await markFailed(env, id, "analysis", reason).catch((e) =>
          console.error("markFailed failed", e),
        );
        msg.ack();
      }
    }
  },

  // Cron sweep: reap submissions stranded in an in-flight state past the
  // worker wall-time ceiling. A platform eviction bypasses the in-worker
  // try/catch, so without this a stuck row would show "running…" forever.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Log the exact cron string Cloudflare passes so we can confirm scheduled()
    // fires and that the daily gate below matches (wrangler tail / dashboard).
    console.log(`scheduled tick: cron="${controller.cron}"`);
    // Reapers run on every cron tick (cheap + idempotent).
    const queued = await reapStaleLlmQueueWait(env);
    if (queued > 0) console.log(`reaper: marked ${queued} stale LLM queue wait submission(s) failed`);
    const n = await reapStalledSubmissions(env);
    if (n > 0) console.log(`reaper: marked ${n} stalled submission(s) failed`);
    const w = await reapStalledWeeklyDrafts(env);
    if (w > 0) console.log(`reaper: marked ${w} stalled weekly draft(s) failed`);

    // Daily-only: auto-publish the newest N 'ready' submissions. Gated on the
    // exact cron so it never fires on the */5 reaper tick.
    if (controller.cron === DAILY_PUBLISH_CRON) {
      const r = await autoPublishReady(env, DAILY_PUBLISH_COUNT);
      console.log(`auto-publish: published ${r.published.length}, skipped ${r.skipped}`);

      // Fold the day's newly published picks into the wiki so /wiki never
      // lags the corpus. Incremental sweeps everything the current map does
      // not cover, so it also mops up picks published by hand since the last
      // build. A failed enqueue must not fail the publish cron — log and go.
      if (r.published.length > 0) {
        try {
          await logEvent(env, "wiki", "queue", "queued", {
            message: `auto wiki update after daily publish (+${r.published.length} picks)`,
            meta: { target: "glean-llm", source: "daily-cron", kind: "wiki", mode: "incremental" },
          });
          await env.INGEST_LLM.send("wiki|kind=wiki&mode=incremental");
          console.log("auto-publish: enqueued incremental wiki update");
        } catch (err) {
          console.error("auto-publish: wiki enqueue failed", (err as Error).message);
        }
      }
    }
  },

  async fetch(req: Request, rawEnv: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/process") {
      // Dev path (Pages proxies here): honor the default-provider toggle too.
      const env = withLlmProviderSetting(rawEnv, await getLlmProviderSetting(rawEnv.DB));
      const explicitId = url.searchParams.get("id");
      const modelOverride = url.searchParams.get("model") || undefined;
      const phase = url.searchParams.get("phase") === "sections" ? "sections" : undefined;
      const kindRaw = url.searchParams.get("kind");
      const kind = kindRaw === "weekly" ? "weekly" : kindRaw === "wiki" ? "wiki" : undefined;

      // Wiki rebuild (dev): no id needed — runWikiBuild reads all published picks.
      if (kind === "wiki") {
        const modeRaw = url.searchParams.get("mode");
        const result = await runWikiBuild(env, { mode: modeRaw === "incremental" ? "incremental" : "full" });
        return json({ ok: result.ok, stage: "wiki", result });
      }

      // Weekly draft (dev): the Pages route proxies here with an explicit id so
      // the draft fires without waiting for the dev queue poller.
      if (kind === "weekly") {
        if (!explicitId) return json({ ok: false, error: "kind=weekly requires id" }, 400);
        const result = await runWeeklyDraft(env, explicitId);
        return json({ ok: result.status === "ready", stage: "weekly", id: explicitId, result });
      }

      let targetId = explicitId;
      if (!targetId) {
        // Pick the oldest submission that has an extracted body but no AI output.
        const db = drizzle(env.DB);
        const row = await db
          .select({ id: submissions.id })
          .from(submissions)
          .where(
            and(
              inArray(submissions.status, ["pending", "analyzing", "composing"]),
              isNotNull(submissions.rawR2Key),
            ),
          )
          .orderBy(asc(submissions.createdAt))
          .limit(1);
        targetId = row[0]?.id ?? null;
      }
      if (!targetId) {
        return json({ ok: false, error: "no submission ready for LLM stage" }, 404);
      }
      try {
        if (phase === "sections") {
          await runSectionsOnly(env, targetId, modelOverride);
          return json({ ok: true, stage: "sections", id: targetId });
        }
        const result = await processLlm(env, targetId, { modelOverride });
        // Dev has no 15-min ceiling and no queue poller, so run sections inline
        // here instead of enqueuing a separate message.
        if (result.needsSections) {
          await runSectionsOnly(env, targetId, modelOverride);
        }
        return json({ ok: true, stage: "llm", result });
      } catch (err) {
        const reason = (err as Error).message ?? "unknown";
        await logEvent(env, targetId, "llm", "failed", {
          message: reason,
          meta: { attempts: 1, source: "fetch-handler", modelOverride, phase },
        });
        if (phase !== "sections") {
          await markFailed(env, targetId, "analysis", reason).catch(() => {});
        }
        return json({ ok: false, id: targetId, error: reason }, 500);
      }
    }
    return new Response("glean-llm worker: POST /process[?id=<ULID>][&model=<name>][&phase=sections]", { status: 200 });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
