/**
 * Wiki index generation — the LLM-Wiki "ingest" step.
 *
 * Published picks are the raw data; this synthesizes them into a single
 * bilingual "map of the corpus": a short intro + a handful of themed topics,
 * each cross-linking the relevant pick slugs. A rebuild publishes live (the
 * newest wiki_index row is what /wiki shows).
 *
 * Two modes:
 * - "full": re-synthesize the map from the newest MAX_PICKS picks. The
 *   periodic consolidation pass — restructures themes from scratch.
 * - "incremental": fold the picks the current wiki does NOT cover into the
 *   existing themes. The model returns a small DELTA (slug → theme-number
 *   assignments + optional new themes) and the code merges it
 *   deterministically, so existing topics can never lose slugs to a model
 *   rewrite. Coverage is anchored on the set difference (published minus
 *   referenced), not on timestamps — it also heals gaps left by older builds.
 *   This is the daily path: the auto-publish cron enqueues one increment.
 *
 * Both modes append a "未分类 / Miscellaneous" topic for anything the model
 * failed to place, so every pick in the window is reachable from /wiki.
 *
 * Prompts live in llm.ts (PROMPT_REGISTRY keys "wiki" / "wiki_incremental")
 * so the admin can edit them in /admin/settings like every other prompt; the
 * call itself stays here with its OWN streaming plumbing. NO provider
 * fallback — if the configured provider fails (e.g. a ModelScope 429 quota
 * error), that exact error is logged and surfaced on /admin/wiki.
 *
 * runWikiBuild is non-throwing (it logs + returns a summary) — same contract
 * as runWeeklyDraft, so the queue consumer just acks.
 */
import { z } from "zod";
import { db as makeDb } from "~/db/client";
import { wikiIndex } from "~/db/schema";
import { pickProvider, resolveProviderSpec, getPrompt, type LlmProvider } from "./llm";
import { picksForWiki, currentWikiIndex, type WikiCatalogPick } from "./queries";
import { logEvent, type IngestEnv } from "./ingest";
import { ulid } from "./ulid";

/** Full rebuild folds in the newest N picks (output size bounds the call). */
export const MAX_PICKS = 200;
/** Incremental sweep window — how far back we look for uncovered picks. */
const SWEEP_CAP = 1000;
/** Max picks folded in per incremental run; the rest wait for the next run. */
const INCREMENT_CAP = 120;
const SUMMARY_CAP = 120; // chars per pick — clustering needs a hint, not the whole summary.
// Generous: output tokens scale with catalog size (~107s for 80 picks on
// V4-Flash), so give the stream real headroom under the worker's 15-min
// wall-time ceiling instead of re-tripping the timeout as the corpus grows.
const CALL_TIMEOUT_MS = 480_000;

export type WikiBuildMode = "full" | "incremental";

export interface WikiTopic {
  title_zh: string;
  title_en: string;
  blurb_zh: string;
  blurb_en: string;
  pick_slugs: string[];
}

export interface WikiIndexView {
  intro_zh: string;
  intro_en: string;
  topics: WikiTopic[];
  picks_count: number;
  model: string | null;
  generated_at: Date | null;
}

const TopicSchema = z.object({
  title_zh: z.string().default(""),
  title_en: z.string().default(""),
  blurb_zh: z.string().default(""),
  blurb_en: z.string().default(""),
  pick_slugs: z.array(z.string()).default([]),
});

const WikiResponseSchema = z.object({
  intro_zh: z.string(),
  intro_en: z.string(),
  topics: z.array(TopicSchema).default([]),
});

/** The incremental call returns a delta, not the whole map. */
const WikiDeltaSchema = z.object({
  assignments: z
    .array(z.object({ slug: z.string(), topics: z.array(z.number()).default([]) }))
    .default([]),
  new_topics: z.array(TopicSchema).default([]),
});
export type WikiDelta = z.infer<typeof WikiDeltaSchema>;

export const MISC_TITLE_ZH = "未分类";
export const MISC_TITLE_EN = "Miscellaneous";

function catalogLines(picks: WikiCatalogPick[]): string {
  // Clustering only needs a hint per article, not the full summary — trimming
  // keeps the prompt small over a large corpus.
  return picks
    .map((p) => {
      const hint = p.summary_en.length > SUMMARY_CAP ? p.summary_en.slice(0, SUMMARY_CAP) + "…" : p.summary_en;
      return `- ${p.slug} :: ${p.title_en} / ${p.title_zh} — ${hint} [${p.category}; ${p.tags.map((t) => t.slug).join(", ")}]`;
    })
    .join("\n");
}

function buildWikiUserMessage(picks: WikiCatalogPick[]): string {
  return `Catalog (${picks.length} articles):\n${catalogLines(picks)}`;
}

function buildIncrementalUserMessage(topics: WikiTopic[], picks: WikiCatalogPick[]): string {
  const themes = topics
    .map((t, i) => {
      const blurb = t.blurb_en.length > 100 ? t.blurb_en.slice(0, 100) + "…" : t.blurb_en;
      return `${i}. ${t.title_en} / ${t.title_zh}${blurb ? ` — ${blurb}` : ""}`;
    })
    .join("\n");
  return `Existing themes:\n${themes}\n\nNew articles (${picks.length}):\n${catalogLines(picks)}`;
}

/* ============================================================
 * Pure topic surgery — exported for scripts/wiki.test.ts
 * ============================================================ */

/** Keep only slugs that actually exist (deduped), drop empty/untitled topics. */
export function normalizeTopics(topics: WikiTopic[], known: Set<string>): WikiTopic[] {
  return topics
    .map((t) => ({ ...t, pick_slugs: [...new Set(t.pick_slugs)].filter((s) => known.has(s)) }))
    .filter((t) => t.pick_slugs.length > 0 && (t.title_zh.trim() || t.title_en.trim()) !== "");
}

/** Guarantee coverage: any of `slugs` not referenced by a topic lands in a
 *  "未分类 / Miscellaneous" topic (appended, or merged into an existing one). */
export function withMiscFallback(topics: WikiTopic[], slugs: string[]): WikiTopic[] {
  const referenced = new Set(topics.flatMap((t) => t.pick_slugs));
  const uncovered = slugs.filter((s) => !referenced.has(s));
  if (uncovered.length === 0) return topics;
  const idx = topics.findIndex(
    (t) => t.title_en.trim() === MISC_TITLE_EN || t.title_zh.trim() === MISC_TITLE_ZH,
  );
  if (idx >= 0) {
    const misc = topics[idx]!;
    return topics.map((t, i) =>
      i === idx ? { ...misc, pick_slugs: [...new Set([...misc.pick_slugs, ...uncovered])] } : t,
    );
  }
  return [
    ...topics,
    {
      title_zh: MISC_TITLE_ZH,
      title_en: MISC_TITLE_EN,
      blurb_zh: "尚未归入主题的收录；下一次全量重建会重新归类。",
      blurb_en: "Picks not yet folded into a theme; the next full rebuild re-files them.",
      pick_slugs: uncovered,
    },
  ];
}

/** Deterministically merge an incremental delta into the existing topics.
 *  Only slugs in `allowed` (this run's new picks) can be added; assignment
 *  indexes outside the existing-topic range are ignored; existing slugs are
 *  never removed or reordered. */
export function mergeWikiDelta(existing: WikiTopic[], delta: WikiDelta, allowed: Set<string>): WikiTopic[] {
  const topics = existing.map((t) => ({ ...t, pick_slugs: [...t.pick_slugs] }));
  for (const a of delta.assignments) {
    if (!allowed.has(a.slug)) continue;
    for (const i of a.topics) {
      if (!Number.isInteger(i) || i < 0 || i >= topics.length) continue;
      const target = topics[i]!;
      if (!target.pick_slugs.includes(a.slug)) target.pick_slugs.push(a.slug);
    }
  }
  const fresh = normalizeTopics(delta.new_topics, allowed);
  return [...topics, ...fresh];
}

/* ============================================================
 * LLM call (streaming) + JSON extraction
 * ============================================================ */

// Always streams. Reasoning models on ModelScope return their answer ONLY via
// streaming deltas — a non-streaming call yields an empty message.content
// ("empty completion"). We accumulate delta.content and ignore
// delta.reasoning_content (chain-of-thought must not pollute the JSON).
async function callWikiLlm(provider: LlmProvider, system: string, user: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(provider.baseUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: provider.model,
        response_format: { type: "json_object" },
        temperature: 0.3,
        // Output scales with topic-slug volume on a full rebuild (200 picks ≈
        // 6-10K tokens of JSON); 16K keeps headroom. Increments are tiny.
        max_tokens: 16000,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${provider.name} fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new Error(`${provider.name}: empty response stream`);
  }

  let content = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string") content += delta;
        } catch {
          /* keep-alive / partial frame — ignore */
        }
      }
    }
  } catch (err) {
    // An aborted read throws a bare "The operation was aborted" — name the
    // culprit so /admin/wiki shows a diagnosable reason, not a mystery.
    const m = (err as Error).message ?? String(err);
    throw new Error(
      ctrl.signal.aborted ? `${provider.name}: stream timed out after ${CALL_TIMEOUT_MS / 1000}s (${m})` : m,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!content.trim()) {
    throw new Error(`${provider.name}: empty completion (stream)`);
  }
  return content;
}

/** Strip ```json fences and parse the model's JSON object. */
function parseWikiJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  return JSON.parse(slice);
}

// Stable id under which every wiki-build lifecycle event is logged, so
// /admin/wiki can read the latest one and show live state (started/ok/failed +
// reason). The rebuild endpoint logs the initial queue/queued under the same id.
export const WIKI_EVENT_ID = "wiki";

/** Drop slugs from the live wiki map (e.g. after unpublishing a pick) by
 *  inserting a corrected copy as the new live version — deterministic, no LLM.
 *  Returns false when the live map doesn't reference any of the slugs. */
export async function removeFromWikiIndex(d1: D1Database, slugs: string[]): Promise<boolean> {
  const db = makeDb(d1);
  const wiki = await currentWikiIndex(db);
  if (!wiki) return false;
  const dead = new Set(slugs);
  if (!wiki.topics.some((t) => t.pick_slugs.some((s) => dead.has(s)))) return false;
  const topics = wiki.topics
    .map((t) => ({ ...t, pick_slugs: t.pick_slugs.filter((s) => !dead.has(s)) }))
    .filter((t) => t.pick_slugs.length > 0);
  const now = new Date();
  await db.insert(wikiIndex).values({
    id: ulid(),
    introZh: wiki.intro_zh,
    introEn: wiki.intro_en,
    topicsJson: JSON.stringify(topics),
    model: wiki.model,
    picksCount: Math.max(0, wiki.picks_count - slugs.length),
    generatedAt: now,
    createdAt: now,
  });
  return true;
}

function wikiProvider(env: IngestEnv): LlmProvider {
  // Use WIKI_MODEL if set (a deliberate, provider-agnostic choice — point the
  // wiki at a FAST non-reasoning model, e.g. ModelScope V4-Flash, so clustering
  // the catalog doesn't burn minutes of reasoning tokens). Else the configured
  // default provider. NO fallback: a provider error surfaces verbatim.
  const wikiModel = (env as { WIKI_MODEL?: string }).WIKI_MODEL?.trim();
  return wikiModel ? resolveProviderSpec(env, wikiModel) : pickProvider(env);
}

export async function runWikiBuild(
  env: IngestEnv,
  opts?: { mode?: WikiBuildMode },
): Promise<{ ok: boolean; mode: WikiBuildMode; topics: number; picks: number; reason?: string }> {
  let mode: WikiBuildMode = opts?.mode ?? "full";
  const t0 = Date.now();
  const secs = (): number => Math.round((Date.now() - t0) / 1000);
  await logEvent(env, WIKI_EVENT_ID, "llm", "started", {
    message: `building wiki index (${mode})…`,
    meta: { kind: "wiki", mode },
  });
  try {
    const db = makeDb(env.DB);

    // Incremental needs an existing map to extend; without one, fall through
    // to a full build (first run, or after the table was cleared).
    const existing = mode === "incremental" ? await currentWikiIndex(db) : null;
    if (mode === "incremental" && !existing) mode = "full";

    if (mode === "incremental" && existing) {
      const all = await picksForWiki(db, SWEEP_CAP);
      const referenced = new Set(existing.topics.flatMap((t) => t.pick_slugs));
      const uncovered = all.filter((p) => !referenced.has(p.slug));
      if (uncovered.length === 0) {
        await logEvent(env, WIKI_EVENT_ID, "llm", "ok", {
          message: `wiki already covers all ${all.length} published picks — nothing to fold in · ${secs()}s`,
          meta: { kind: "wiki", mode, added: 0 },
        });
        return { ok: true, mode, topics: existing.topics.length, picks: all.length };
      }

      const batch = uncovered.slice(0, INCREMENT_CAP);
      const dropped = uncovered.length - batch.length;
      const provider = wikiProvider(env);
      const content = await callWikiLlm(
        provider,
        await getPrompt(env, "wiki_incremental"),
        buildIncrementalUserMessage(existing.topics, batch),
      );
      const delta = WikiDeltaSchema.parse(parseWikiJson(content));
      const allowed = new Set(batch.map((p) => p.slug));
      const topics = withMiscFallback(
        mergeWikiDelta(existing.topics, delta, allowed),
        batch.map((p) => p.slug),
      );
      const newTopics = topics.length - existing.topics.length;

      await db.insert(wikiIndex).values({
        id: ulid(),
        introZh: existing.intro_zh,
        introEn: existing.intro_en,
        topicsJson: JSON.stringify(topics),
        model: provider.model,
        picksCount: all.length,
        generatedAt: new Date(),
        createdAt: new Date(),
      });

      await logEvent(env, WIKI_EVENT_ID, "llm", "ok", {
        message:
          `wiki updated · +${batch.length} picks folded in` +
          (newTopics > 0 ? ` (+${newTopics} topics)` : "") +
          ` · now ${topics.length} topics covering ${all.length} picks (${provider.model}) · ${secs()}s` +
          (dropped > 0 ? ` · ${dropped} more wait for the next run` : ""),
        meta: { kind: "wiki", mode, added: batch.length, dropped, topics: topics.length },
      });
      return { ok: true, mode, topics: topics.length, picks: all.length };
    }

    // Full rebuild.
    const picks = await picksForWiki(db, MAX_PICKS);
    if (picks.length === 0) {
      const reason = "no published picks to build a wiki from";
      await logEvent(env, WIKI_EVENT_ID, "llm", "failed", { message: reason, meta: { kind: "wiki", mode } });
      return { ok: false, mode, topics: 0, picks: 0, reason };
    }

    const provider = wikiProvider(env);
    const content = await callWikiLlm(provider, await getPrompt(env, "wiki"), buildWikiUserMessage(picks));
    const parsed = WikiResponseSchema.parse(parseWikiJson(content));

    const known = new Set(picks.map((p) => p.slug));
    const topics = withMiscFallback(
      normalizeTopics(parsed.topics, known),
      picks.map((p) => p.slug),
    );

    if (topics.length === 0) {
      const reason = "LLM produced no usable topics";
      await logEvent(env, WIKI_EVENT_ID, "llm", "failed", { message: reason, meta: { kind: "wiki", mode } });
      return { ok: false, mode, topics: 0, picks: picks.length, reason };
    }

    await db.insert(wikiIndex).values({
      id: ulid(),
      introZh: parsed.intro_zh,
      introEn: parsed.intro_en,
      topicsJson: JSON.stringify(topics),
      model: provider.model,
      picksCount: picks.length,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    await logEvent(env, WIKI_EVENT_ID, "llm", "ok", {
      message: `wiki index rebuilt · ${topics.length} topics from ${picks.length} picks (${provider.model}) · ${secs()}s`,
      meta: { kind: "wiki", mode, topics: topics.length, picks: picks.length },
    });
    return { ok: true, mode, topics: topics.length, picks: picks.length };
  } catch (err) {
    const reason = (err as Error).message ?? "unknown wiki build error";
    await logEvent(env, WIKI_EVENT_ID, "llm", "failed", {
      message: reason,
      meta: { kind: "wiki", mode, source: "wiki-throw" },
    });
    return { ok: false, mode, topics: 0, picks: 0, reason };
  }
}
