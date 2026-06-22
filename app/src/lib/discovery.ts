/**
 * Auto-discovery: pull candidate URLs from RSS/HN/arXiv, dedup, gate-1
 * prescore, and enqueue survivors into the existing submission pipeline.
 * Parsers here are PURE (string/JSON in → Candidate[] out) so they unit-test
 * without network. Network + orchestration live in runDiscovery (below).
 */

export interface Candidate {
  /** Raw URL as found in the source (normalized later, at dedup time). */
  url: string;
  title: string;
  snippet: string;
  /** "auto:hn" | "auto:arxiv" | "auto:rss:<id>" — becomes submissions.source. */
  source: string;
}

/** Minimal HTML/XML entity decode for titles/snippets pulled from feeds. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Strip CDATA wrappers and tags, collapse whitespace. */
function clean(s: string): string {
  return decodeEntities(
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
}

function firstMatch(block: string, re: RegExp): string {
  const m = block.match(re);
  return m ? clean(m[1] ?? "") : "";
}

/**
 * Parse an RSS 2.0 or Atom feed. `sourceId` is the config id (e.g.
 * "rss:simonwillison"); the emitted source is `auto:<sourceId>`.
 * Tolerant by design: regex over <item>/<entry> blocks, no XML lib.
 */
export function parseFeed(xml: string, sourceId: string): Candidate[] {
  const source = `auto:${sourceId}`;
  const out: Candidate[] = [];
  // RSS <item> ... </item> OR Atom <entry> ... </entry>
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/g) ?? [];
  for (const block of blocks) {
    const title = firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/);
    // RSS: <link>URL</link>. Atom: <link href="URL" .../> (prefer rel=alternate).
    let url = firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/);
    if (!url) {
      const atom =
        block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
        block.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = atom ? decodeEntities(atom[1] ?? "") : "";
    }
    const snippet =
      firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/) ||
      firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/) ||
      firstMatch(block, /<content[^>]*>([\s\S]*?)<\/content>/);
    if (url && title) out.push({ url, title, snippet: snippet.slice(0, 500), source });
  }
  return out;
}

interface HnHit {
  title?: string | null;
  url?: string | null;
  points?: number | null;
  objectID?: string | null;
}

/** Parse a Hacker News Algolia search response, keeping story hits with a real
 *  URL and at least `minPoints` points. */
export function parseHnHits(json: { hits?: HnHit[] }, minPoints: number): Candidate[] {
  const hits = json.hits ?? [];
  const out: Candidate[] = [];
  for (const h of hits) {
    if (!h.url || !h.title) continue; // Ask HN / job posts have no url
    if ((h.points ?? 0) < minPoints) continue;
    out.push({
      url: h.url,
      title: clean(h.title),
      snippet: `HN ${h.points ?? 0} points`,
      source: "auto:hn",
    });
  }
  return out;
}

/** Parse an arXiv API (Atom) response. The canonical URL is the <id> abs link. */
export function parseArxivXml(xml: string): Candidate[] {
  const out: Candidate[] = [];
  const blocks = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];
  for (const block of blocks) {
    const title = firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/);
    const url = firstMatch(block, /<id[^>]*>([\s\S]*?)<\/id>/);
    const snippet = firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/);
    if (url && title && /arxiv\.org\/abs\//.test(url)) {
      out.push({ url, title, snippet: snippet.slice(0, 500), source: "auto:arxiv" });
    }
  }
  return out;
}

import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";
import { submissions, picks, discoverySeen } from "~/db/schema";
import { normalizeUrl } from "~/lib/normalize-url";
import { ulid } from "~/lib/ulid";
import { logEvent } from "~/lib/ingest";
import { callLlmPrescore, type LlmEnv } from "~/lib/llm";

/** Gate-1 floor: candidates the prescore rates below this are dropped before
 *  any fetch/extract spend. The real 7-dim gate (0.7) happens later in
 *  processLlm; this is only a cheap firehose-reducer. */
export const PRESCORE_FLOOR = 0.4;

export interface DiscoveryEnv extends LlmEnv {
  DB: D1Database;
  /** Producer binding to the glean-ingest queue (same queue /api/submit uses). */
  INGEST: Queue<string>;
}

/** Pure: drop candidates whose normalized URL is already known or repeats
 *  within the batch. `norm` is injected so tests don't need the real
 *  normalizeUrl. Returns the fresh candidates + their normalized keys. */
export function partitionUnseen(
  candidates: Candidate[],
  known: Set<string>,
  norm: (u: string) => string,
): { fresh: Candidate[]; freshKeys: string[] } {
  const seenInBatch = new Set<string>();
  const fresh: Candidate[] = [];
  const freshKeys: string[] = [];
  for (const cand of candidates) {
    let key: string;
    try { key = norm(cand.url); } catch { continue; }
    if (!key || known.has(key) || seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    fresh.push(cand);
    freshKeys.push(key);
  }
  return { fresh, freshKeys };
}

/** Insert one auto candidate as a submission and enqueue it to glean-ingest —
 *  the same path /api/submit takes, minus Turnstile/rate-limit (internal). */
async function enqueueCandidate(env: DiscoveryEnv, cand: Candidate, normalizedUrl: string): Promise<void> {
  const id = ulid();
  const db = drizzle(env.DB);
  await db.insert(submissions).values({
    id,
    url: normalizedUrl,
    note: null,
    submitterName: null,
    submitterIpHash: null,
    source: cand.source,
    status: "pending",
    processingStartedAt: new Date(),
    processingModel: "extract",
    createdAt: new Date(),
  });
  await env.INGEST.send(id);
  await logEvent(env as never, id, "queue", "queued", {
    message: "auto-discovered submission",
    meta: { target: "glean-ingest", source: cand.source },
  });
}

export interface DiscoveryRunResult {
  fetched: number;
  fresh: number;
  passedGate1: number;
  enqueued: number;
}

/** D1/SQLite caps bound variables per statement (~100). Split arrays so the
 *  `inArray(...)` lookups and the batch insert never exceed that ceiling — a
 *  live feed batch routinely has hundreds of fresh URLs. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * One discovery run: collect from all provided adapter thunks, dedup against
 * discovery_seen + submissions + picks, record every fresh URL as seen, gate-1
 * prescore, enqueue survivors. Each adapter is awaited under its own try/catch
 * by the caller (see the worker) so one bad source can't sink the run.
 */
export async function runDiscovery(
  env: DiscoveryEnv,
  candidates: Candidate[],
): Promise<DiscoveryRunResult> {
  const db = drizzle(env.DB);
  const fetched = candidates.length;
  if (fetched === 0) return { fetched: 0, fresh: 0, passedGate1: 0, enqueued: 0 };

  // Build the `known` set: discovery_seen ∪ existing submissions ∪ picks, all
  // keyed by normalized URL. Query only the URLs in this batch.
  const keys = candidates.map((c) => { try { return normalizeUrl(c.url); } catch { return ""; } }).filter(Boolean);
  const known = new Set<string>();
  for (const part of chunk(keys, 90)) {
    const seenRows = await db.select({ u: discoverySeen.urlNormalized }).from(discoverySeen).where(inArray(discoverySeen.urlNormalized, part));
    for (const r of seenRows) known.add(r.u);
    const subRows = await db.select({ u: submissions.url }).from(submissions).where(inArray(submissions.url, part));
    for (const r of subRows) known.add(r.u);
    const pickRows = await db.select({ u: picks.sourceUrl }).from(picks).where(inArray(picks.sourceUrl, part));
    for (const r of pickRows) known.add(r.u);
  }

  const { fresh, freshKeys } = partitionUnseen(candidates, known, normalizeUrl);
  if (fresh.length === 0) {
    console.log(`discovery: fetched=${fetched} fresh=0 (all known)`);
    return { fetched, fresh: 0, passedGate1: 0, enqueued: 0 };
  }

  // Record every fresh URL as seen NOW — even ones gate 1 will drop — so we
  // never re-score them on the next tick. Each row binds 3 columns
  // (url_normalized, source, first_seen_at), and D1 caps a statement at 100
  // bound variables — so chunk at 30 rows (90 binds) to stay safely under it.
  const seenValues = fresh.map((c, i) => ({ urlNormalized: freshKeys[i]!, source: c.source }));
  for (const part of chunk(seenValues, 30)) {
    await db.insert(discoverySeen).values(part).onConflictDoNothing();
  }

  // Gate 1: cheap prescore. On error, fail-open (treat all as passing) so a
  // prescore outage doesn't stall discovery — gate 2 still protects spend.
  let scores: number[];
  try {
    scores = await callLlmPrescore(env, fresh.map((c) => ({ title: c.title, snippet: c.snippet })));
  } catch (err) {
    console.warn("discovery: prescore failed, passing all", (err as Error).message);
    scores = fresh.map(() => 1);
  }
  const passed = fresh.filter((_, i) => (scores[i] ?? 0) >= PRESCORE_FLOOR);

  let enqueued = 0;
  for (let i = 0; i < fresh.length; i++) {
    if ((scores[i] ?? 0) < PRESCORE_FLOOR) continue;
    try {
      await enqueueCandidate(env, fresh[i]!, freshKeys[i]!);
      enqueued++;
    } catch (err) {
      console.error("discovery: enqueue failed", fresh[i]!.url, (err as Error).message);
    }
  }

  const result = { fetched, fresh: fresh.length, passedGate1: passed.length, enqueued };
  console.log(`discovery run: ${JSON.stringify(result)}`);
  return result;
}
