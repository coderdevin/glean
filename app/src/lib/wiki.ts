/**
 * Wiki index generation — the LLM-Wiki "ingest" step.
 *
 * Published picks are the raw data; this synthesizes them into a single
 * bilingual "map of the corpus": a short intro + a handful of themed topics,
 * each cross-linking the relevant pick slugs. Admin triggers a rebuild; a
 * rebuild publishes live (the newest wiki_index row is what /wiki shows).
 *
 * Deliberately self-contained: it reuses only the exported provider resolver
 * from ./llm and makes its OWN non-streaming JSON call with its OWN prompt, so
 * the editorial prompts + streaming plumbing in llm.ts stay untouched.
 *
 * runWikiBuild is non-throwing (it logs + returns a summary) — same contract as
 * runWeeklyDraft, so the queue consumer just acks.
 */
import { z } from "zod";
import { db as makeDb } from "~/db/client";
import { wikiIndex } from "~/db/schema";
import { pickProvider, type LlmProvider } from "./llm";
import { searchPicks } from "./queries";
import { logEvent, type IngestEnv } from "./ingest";
import { ulid } from "./ulid";

const MAX_PICKS = 200; // newest N folded in; corpus is small. picks_count records the snapshot.
const CALL_TIMEOUT_MS = 90_000;

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

const WikiResponseSchema = z.object({
  intro_zh: z.string(),
  intro_en: z.string(),
  topics: z
    .array(
      z.object({
        title_zh: z.string(),
        title_en: z.string(),
        blurb_zh: z.string().default(""),
        blurb_en: z.string().default(""),
        pick_slugs: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const WIKI_SYSTEM_PROMPT = `You are the curator of a bilingual (Chinese + English) tech-article wiki.
You are given the full catalog of published articles (slug :: title — summary [category, tags]).
Synthesize them into a concise "map of the collection":

- A short bilingual intro (1–2 sentences each) describing what the collection covers.
- 4–8 coherent themes. For each theme: a bilingual title, a 1–2 sentence bilingual blurb,
  and the list of slugs that belong to it (use ONLY slugs from the catalog; every article
  should appear in at least one theme; an article may appear in more than one if it fits).

Write naturally in both languages — don't translate word-for-word. Respond with ONLY a JSON
object of this exact shape:
{"intro_zh":"...","intro_en":"...","topics":[{"title_zh":"...","title_en":"...","blurb_zh":"...","blurb_en":"...","pick_slugs":["..."]}]}`;

function buildWikiUserMessage(
  picks: { slug: string; title_en: string; title_zh: string; summary_en: string; category: string; tags: { slug: string }[] }[],
): string {
  const catalog = picks
    .map(
      (p) =>
        `- ${p.slug} :: ${p.title_en} / ${p.title_zh} — ${p.summary_en} [${p.category}; ${p.tags.map((t) => t.slug).join(", ")}]`,
    )
    .join("\n");
  return `Catalog (${picks.length} articles):\n${catalog}`;
}

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
      },
      body: JSON.stringify({
        model: provider.model,
        response_format: { type: "json_object" },
        temperature: 0.3,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${provider.name}: empty completion`);
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

export async function runWikiBuild(
  env: IngestEnv,
): Promise<{ ok: boolean; topics: number; picks: number; reason?: string }> {
  const id = ulid();
  try {
    const db = makeDb(env.DB);
    const picks = await searchPicks(db, { limit: MAX_PICKS });
    if (picks.length === 0) {
      const reason = "no published picks to build a wiki from";
      await logEvent(env, id, "llm", "failed", { message: reason, meta: { kind: "wiki" } });
      return { ok: false, topics: 0, picks: 0, reason };
    }

    const provider = pickProvider(env);
    const content = await callWikiLlm(
      provider,
      WIKI_SYSTEM_PROMPT,
      buildWikiUserMessage(
        picks.map((p) => ({
          slug: p.slug,
          title_en: p.title_en,
          title_zh: p.title_zh,
          summary_en: p.summary_en,
          category: p.category,
          tags: p.tags,
        })),
      ),
    );

    const parsed = WikiResponseSchema.parse(parseWikiJson(content));

    // Keep only slugs that actually exist, and drop topics left empty.
    const known = new Set(picks.map((p) => p.slug));
    const topics: WikiTopic[] = parsed.topics
      .map((t) => ({ ...t, pick_slugs: t.pick_slugs.filter((s) => known.has(s)) }))
      .filter((t) => t.pick_slugs.length > 0 && (t.title_zh.trim() || t.title_en.trim()));

    if (topics.length === 0) {
      const reason = "LLM produced no usable topics";
      await logEvent(env, id, "llm", "failed", { message: reason, meta: { kind: "wiki" } });
      return { ok: false, topics: 0, picks: picks.length, reason };
    }

    await db.insert(wikiIndex).values({
      id,
      introZh: parsed.intro_zh,
      introEn: parsed.intro_en,
      topicsJson: JSON.stringify(topics),
      model: provider.model,
      picksCount: picks.length,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    await logEvent(env, id, "llm", "queued", {
      message: "wiki index rebuilt",
      meta: { kind: "wiki", topics: topics.length, picks: picks.length },
    });
    return { ok: true, topics: topics.length, picks: picks.length };
  } catch (err) {
    const reason = (err as Error).message ?? "unknown wiki build error";
    await logEvent(env, id, "llm", "failed", { message: reason, meta: { kind: "wiki", source: "wiki-throw" } });
    return { ok: false, topics: 0, picks: 0, reason };
  }
}
