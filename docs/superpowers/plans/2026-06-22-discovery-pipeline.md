# Discovery Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically discover high-quality article URLs (RSS / Hacker News / arXiv) and feed them into Glean's existing review pipeline through a two-gate cost funnel, so the editor stops hand-submitting links — while human sign-off at publish stays untouched.

**Architecture:** A new scheduled Cloudflare Worker (`discovery-consumer`, cron twice daily) runs per-source adapters → dedupes against `discovery_seen` + `submissions` + `picks` → **gate 1** (cheap batch LLM prescore on title+snippet) drops obvious junk → survivors are inserted as `submissions(source="auto:…")` and enqueued exactly like `/api/submit` does. The existing `processLlm` phase-1 produces the real 7-dim score; **gate 2** (inside `processLlm`) holds auto rows scoring `< 0.7` at a new terminal status `screened` (visible in `/admin`, never auto-published) instead of running the expensive phase-2 sections.

**Tech Stack:** Astro 4 (SSR) + Cloudflare Workers/Queues/D1/R2, Drizzle ORM, TypeScript, `tsx` + `node:assert` tests. LLM via the existing `src/lib/llm.ts` provider abstraction (ModelScope/DeepSeek, OpenAI-compatible).

---

## Source spec (from the design doc)

- Design: `docs/superpowers/specs/2026-06-22-discovery-pipeline-design.md`
- Confirmed scope: RSS + HN + arXiv; cron **twice daily**; below-threshold rows **stay visible** in `/admin` as `screened`; source list in a **config file** (no admin UI this round). X/Twitter and Reddit are explicitly out of scope.

## File structure (what each task creates/touches)

| Path | Responsibility |
|---|---|
| `app/migrations/0019_discovery.sql` | Rebuild `submissions` to add `screened` to the status CHECK + add `source` column; create `discovery_seen`. |
| `app/src/db/schema.ts` | Add `screened` to `SUBMISSION_STATUSES`, add `source` column, add `discoverySeen` table + types. |
| `app/src/lib/ingest.ts` | Gate 2: screen auto rows scoring `<0.7` (the `composing` branch in `processLlm`). |
| `app/src/lib/discovery.ts` | NEW. Candidate type, pure feed/HN/arXiv parsers, dedup partition, `runDiscovery()` orchestration + enqueue. |
| `app/src/lib/llm.ts` | NEW `callLlmPrescore()` + pure `parsePrescoreScores()`. |
| `app/workers/discovery-consumer/{wrangler.toml,src/index.ts,src/sources.ts}` | NEW worker: cron `scheduled()` → `runDiscovery`; dev `fetch()` trigger; source config. |
| `app/src/pages/admin/index.astro`, `app/src/components/StatusPill.astro` | Surface `screened` (filter tab + pill) and the `source` badge. |
| `app/scripts/*.test.ts` | One test file per pure unit (gate, parsers, dedup, prescore). |

**Threshold constants (single source of truth):** `AUTO_PUBLISH_SCORE_THRESHOLD = 0.7` lives in `ingest.ts`; `PRESCORE_FLOOR = 0.4` lives in `discovery.ts`.

---

## Task 1: Schema + migration (`screened` status, `source` column, `discovery_seen`)

**Why a full table rebuild:** `submissions.status` carries `CHECK (status IN ('pending','analyzing','composing','ready','published','rejected','failed'))`. SQLite cannot ALTER a CHECK in place — migrations `0008` and `0014` already do the create-new/copy/drop/rename dance. We mirror that exactly, and add the `source` column in the same rebuild.

**Files:**
- Create: `app/migrations/0019_discovery.sql`
- Modify: `app/src/db/schema.ts:10-18` (status enum), `:183-240` (submissions table — add `source`), append `discoverySeen` table near `appSettings` (`:373`).
- Test: `app/scripts/discovery-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/scripts/discovery-schema.test.ts
import assert from "node:assert/strict";
import { SUBMISSION_STATUSES } from "../src/db/schema";
import { discoverySeen, submissions } from "../src/db/schema";

// screened is a recognized status
assert.ok(SUBMISSION_STATUSES.includes("screened" as never), "screened must be in SUBMISSION_STATUSES");

// submissions has a `source` column
assert.ok("source" in submissions, "submissions table must expose a `source` column");

// discovery_seen table is defined with the expected columns
assert.ok("urlNormalized" in discoverySeen, "discovery_seen needs url_normalized PK");
assert.ok("source" in discoverySeen, "discovery_seen needs source");
assert.ok("firstSeenAt" in discoverySeen, "discovery_seen needs first_seen_at");

console.log("discovery-schema.test.ts passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm exec tsx scripts/discovery-schema.test.ts`
Expected: FAIL — `screened` not in `SUBMISSION_STATUSES` / `discoverySeen` undefined.

- [ ] **Step 3: Edit `app/src/db/schema.ts`**

Add `screened` to the status list (keep the existing comments above each):

```ts
export const SUBMISSION_STATUSES = [
  "pending",    // submitted, awaiting pipeline
  "analyzing",  // extract + phase-1 LLM (card fields)
  "composing",  // phase-2 LLM (bilingual body sections)
  "ready",      // AI fully done — editor publishes or rejects
  "published",
  "rejected",   // editor decision (human)
  "failed",     // AI failed at some stage (retriable)
  "screened",   // auto-discovered, phase-1 score < threshold — held for human, never auto-published
] as const;
```

In the `submissions` table definition, add the `source` column right after `submitterIpHash` (`:181`):

```ts
    submitterIpHash: text("submitter_ip_hash"),
    /** Submission origin. "manual" = the public /submit form; "auto:<src>"
     *  (e.g. "auto:hn", "auto:rss:simonwillison", "auto:arxiv") = the
     *  discovery worker. Gate 2 in processLlm screens auto rows that score
     *  below AUTO_PUBLISH_SCORE_THRESHOLD; manual rows always run full. */
    source: text("source").notNull().default("manual"),
```

Add the `discoverySeen` table just before the `appSettings` definition (`:370`):

```ts
/** URLs the discovery worker has already evaluated, so it never re-scores the
 *  same HN/RSS/arXiv item on a later cron tick. Keyed by the normalized URL
 *  (src/lib/normalize-url.ts). A row is written the first time a candidate is
 *  seen, regardless of whether it later passes gate 1. */
export const discoverySeen = sqliteTable("discovery_seen", {
  urlNormalized: text("url_normalized").primaryKey(),
  source: text("source").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DiscoverySeen = typeof discoverySeen.$inferSelect;
```

- [ ] **Step 4: Create `app/migrations/0019_discovery.sql`**

Mirror the `0008`/`0014` rebuild. The column list below is the authoritative current schema (verified via `.schema submissions`). Only two changes vs. current: the status CHECK gains `'screened'`, and a new `source` column is appended.

```sql
-- 0019_discovery.sql
-- Add 'screened' to the submissions status CHECK and a `source` column.
-- SQLite cannot ALTER a CHECK in place (see 0008/0014), so rebuild the table.
-- Also create discovery_seen for the auto-discovery worker's dedup.

PRAGMA foreign_keys=OFF;

CREATE TABLE submissions_new (
  id                text    PRIMARY KEY,
  url               text    NOT NULL,
  note              text,
  submitter_name    text,
  submitter_ip_hash text,
  status            text    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','analyzing','composing','ready','published','rejected','failed','screened')),
  reject_reason     text,
  raw_r2_key        text,
  extracted_lang    text,
  ai_title_zh       text,
  ai_title_en       text,
  ai_summary_zh     text,
  ai_summary_en     text,
  ai_bullets_json   text,
  ai_tags_json      text,
  ai_category       text,
  ai_score          real,
  ai_model          text,
  ai_latency_ms     integer,
  ai_tokens         integer,
  editor_note_zh    text,
  editor_note_en    text,
  linked_pick_id    text,
  created_at        integer NOT NULL,
  processed_at      integer,
  reviewed_at       integer,
  ai_subscores_json text,
  ai_glossary_json  text,
  ai_next_hints_json text,
  ai_sections_json  text,
  processing_started_at integer,
  processing_model  text,
  ai_sections_status text CHECK (ai_sections_status IN ('pending','ok','failed')),
  ai_sections_error text,
  failure_stage     text CHECK (failure_stage IS NULL OR failure_stage IN ('extract','analysis','sections')),
  original_title    text,
  source            text NOT NULL DEFAULT 'manual'
);

INSERT INTO submissions_new (
  id, url, note, submitter_name, submitter_ip_hash, status, reject_reason,
  raw_r2_key, extracted_lang, ai_title_zh, ai_title_en, ai_summary_zh,
  ai_summary_en, ai_bullets_json, ai_tags_json, ai_category, ai_score,
  ai_model, ai_latency_ms, ai_tokens, editor_note_zh, editor_note_en,
  linked_pick_id, created_at, processed_at, reviewed_at, ai_subscores_json,
  ai_glossary_json, ai_next_hints_json, ai_sections_json,
  processing_started_at, processing_model, ai_sections_status,
  ai_sections_error, failure_stage, original_title
)
SELECT
  id, url, note, submitter_name, submitter_ip_hash, status, reject_reason,
  raw_r2_key, extracted_lang, ai_title_zh, ai_title_en, ai_summary_zh,
  ai_summary_en, ai_bullets_json, ai_tags_json, ai_category, ai_score,
  ai_model, ai_latency_ms, ai_tokens, editor_note_zh, editor_note_en,
  linked_pick_id, created_at, processed_at, reviewed_at, ai_subscores_json,
  ai_glossary_json, ai_next_hints_json, ai_sections_json,
  processing_started_at, processing_model, ai_sections_status,
  ai_sections_error, failure_stage, original_title
FROM submissions;

DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX submissions_status_idx ON submissions (status, created_at);

CREATE TABLE discovery_seen (
  url_normalized text PRIMARY KEY,
  source         text NOT NULL,
  first_seen_at  integer NOT NULL
);

PRAGMA foreign_keys=ON;
```

- [ ] **Step 5: Apply locally on a fresh DB and verify the rebuild**

Run:
```sh
cd app && pnpm db:migrate:local
DB=$(find .wrangler -name "*.sqlite" -path "*D1*" | head -1)
sqlite3 "$DB" ".schema submissions" | grep -c "screened"   # expect 1
sqlite3 "$DB" ".schema discovery_seen" | grep -c "url_normalized"  # expect 1
```
Expected: both print `1`. If `db:migrate:local` errors on the rebuild, fix the SQL before continuing.

- [ ] **Step 6: Run the schema test to verify it passes**

Run: `cd app && pnpm exec tsx scripts/discovery-schema.test.ts`
Expected: `discovery-schema.test.ts passed`

- [ ] **Step 7: Typecheck + commit**

```sh
cd app && pnpm typecheck
git add app/src/db/schema.ts app/migrations/0019_discovery.sql app/scripts/discovery-schema.test.ts
git commit -m "feat(discovery): schema — screened status, source column, discovery_seen table"
```

---

## Task 2: Gate 2 — screen low-scoring auto rows in `processLlm`

**Files:**
- Modify: `app/src/lib/ingest.ts` — add the constant + helper near the top of the file (after imports), and branch the `composing` update (`:424-451`) + the return (`:472-483`). Also extend `LlmStageResult.status` (`:87`) to allow `"screened"`.
- Test: `app/scripts/discovery-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/scripts/discovery-gate.test.ts
import assert from "node:assert/strict";
import { shouldScreenAuto, AUTO_PUBLISH_SCORE_THRESHOLD } from "../src/lib/ingest";

assert.equal(AUTO_PUBLISH_SCORE_THRESHOLD, 0.7);

// auto rows below threshold are screened
assert.equal(shouldScreenAuto("auto:hn", 0.62), true);
assert.equal(shouldScreenAuto("auto:rss:foo", 0.0), true);
// auto rows at/above threshold pass
assert.equal(shouldScreenAuto("auto:hn", 0.7), false);
assert.equal(shouldScreenAuto("auto:arxiv", 0.91), false);
// manual rows are NEVER screened, even at score 0
assert.equal(shouldScreenAuto("manual", 0.0), false);
assert.equal(shouldScreenAuto(null, 0.1), false);
assert.equal(shouldScreenAuto(undefined, 0.1), false);

console.log("discovery-gate.test.ts passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm exec tsx scripts/discovery-gate.test.ts`
Expected: FAIL — `shouldScreenAuto` is not exported.

- [ ] **Step 3: Add the constant + helper to `app/src/lib/ingest.ts`**

Add near the other top-level constants (e.g. just above `processLlm`):

```ts
/** Auto-discovered submissions whose phase-1 score is below this are not worth
 *  the expensive phase-2 (bilingual sections) run. They are held at status
 *  'screened' (visible in /admin, never auto-published) instead. Manual /submit
 *  rows are exempt — a human chose to submit them, so they always run full. */
export const AUTO_PUBLISH_SCORE_THRESHOLD = 0.7;

/** True when a row came from the discovery worker AND scored below the
 *  auto-publish threshold — i.e. should be screened out of phase 2. */
export function shouldScreenAuto(
  source: string | null | undefined,
  score: number,
  threshold: number = AUTO_PUBLISH_SCORE_THRESHOLD,
): boolean {
  return (source ?? "manual").startsWith("auto:") && score < threshold;
}
```

- [ ] **Step 4: Extend the `LlmStageResult.status` union**

At `app/src/lib/ingest.ts:87`, change:

```ts
  status: "ready" | "composing";
```
to:
```ts
  status: "ready" | "composing" | "screened";
```

- [ ] **Step 5: Branch the phase-1 result write in `processLlm`**

Just before the `await db.update(submissions).set({ status: "composing", ... })` block (`:424`), compute the decision:

```ts
  const screened = shouldScreenAuto(row.source, analysis.output.score);
```

In that `.set({ ... })` object, replace the two affected fields:

```ts
      status: screened ? "screened" : "composing",
```
and
```ts
      rejectReason: screened
        ? `auto-screened: phase-1 score ${analysis.output.score.toFixed(2)} < ${AUTO_PUBLISH_SCORE_THRESHOLD}`
        : null,
```

After the existing `await logEvent(env, id, "llm", "ok", { message: "analysis phase ok", ... })` call, add a screened event so the timeline is honest:

```ts
  if (screened) {
    await logEvent(env, id, "pipeline", "skipped", {
      message: `screened: score ${analysis.output.score.toFixed(2)} < ${AUTO_PUBLISH_SCORE_THRESHOLD} — phase 2 not run`,
      meta: { phase: "gate2", source: row.source, score: analysis.output.score },
    });
  }
```

Finally, change the return value (`:472-483`) so sections are skipped for screened rows:

```ts
  return {
    id,
    status: screened ? "screened" : "composing",
    provider: analysis.provider.name,
    model: analysis.provider.model,
    latencyMs: analysis.latencyMs,
    totalTokens: analysis.totalTokens,
    reasoningChars: analysis.reasoningChars,
    tagsKept,
    tagsDropped,
    needsSections: !screened,
  };
```

> Note: both callers (`workers/llm-consumer/src/index.ts` queue handler and its dev `fetch` handler) already gate the sections enqueue on `result.needsSections`, so returning `false` here is the entire mechanism — no worker change needed. The idempotency guard (`:294`) only short-circuits `composing`/`ready`/`published`, so a later human "promote" of a `screened` row still works.

- [ ] **Step 6: Run the gate test + typecheck**

Run: `cd app && pnpm exec tsx scripts/discovery-gate.test.ts && pnpm typecheck`
Expected: `discovery-gate.test.ts passed`, typecheck clean.

- [ ] **Step 7: Commit**

```sh
git add app/src/lib/ingest.ts app/scripts/discovery-gate.test.ts
git commit -m "feat(discovery): gate 2 — hold low-scoring auto rows at 'screened'"
```

---

## Task 3: Discovery candidate type + pure source parsers

**Files:**
- Create: `app/src/lib/discovery.ts` (parsers only this task; orchestration in Task 5)
- Test: `app/scripts/discovery-parsers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/scripts/discovery-parsers.test.ts
import assert from "node:assert/strict";
import { parseFeed, parseHnHits, parseArxivXml } from "../src/lib/discovery";

// --- RSS 2.0 ---
{
  const xml = `<rss><channel>
    <item><title>Hello &amp; World</title><link>https://a.example/post</link>
      <description>A short blurb</description></item>
    <item><title>Second</title><link>https://b.example/2</link></item>
  </channel></rss>`;
  const out = parseFeed(xml, "rss:test");
  assert.equal(out.length, 2);
  assert.equal(out[0]!.title, "Hello & World");
  assert.equal(out[0]!.url, "https://a.example/post");
  assert.equal(out[0]!.snippet, "A short blurb");
  assert.equal(out[0]!.source, "auto:rss:test");
}

// --- Atom (link is an attribute) ---
{
  const xml = `<feed><entry><title>Atom Post</title>
    <link href="https://c.example/atom" rel="alternate"/>
    <summary>atom blurb</summary></entry></feed>`;
  const out = parseFeed(xml, "rss:atomtest");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, "https://c.example/atom");
  assert.equal(out[0]!.title, "Atom Post");
}

// --- HN Algolia ---
{
  const json = {
    hits: [
      { title: "Great post", url: "https://hn.example/x", points: 250, objectID: "1" },
      { title: "Ask HN: no url", url: null, points: 300, objectID: "2" },
      { title: "Low points", url: "https://hn.example/y", points: 40, objectID: "3" },
    ],
  };
  const out = parseHnHits(json, 100);
  assert.equal(out.length, 1, "drop null-url and sub-threshold hits");
  assert.equal(out[0]!.url, "https://hn.example/x");
  assert.equal(out[0]!.source, "auto:hn");
}

// --- arXiv Atom ---
{
  const xml = `<feed><entry>
    <title>Deep Thing</title>
    <id>http://arxiv.org/abs/2406.12345v1</id>
    <summary>We propose a thing.</summary></entry></feed>`;
  const out = parseArxivXml(xml);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, "http://arxiv.org/abs/2406.12345v1");
  assert.equal(out[0]!.title, "Deep Thing");
  assert.equal(out[0]!.source, "auto:arxiv");
}

console.log("discovery-parsers.test.ts passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm exec tsx scripts/discovery-parsers.test.ts`
Expected: FAIL — module `../src/lib/discovery` not found.

- [ ] **Step 3: Create `app/src/lib/discovery.ts` with the type + parsers**

```ts
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
```

- [ ] **Step 4: Run the parser test to verify it passes**

Run: `cd app && pnpm exec tsx scripts/discovery-parsers.test.ts`
Expected: `discovery-parsers.test.ts passed`

- [ ] **Step 5: Commit**

```sh
git add app/src/lib/discovery.ts app/scripts/discovery-parsers.test.ts
git commit -m "feat(discovery): candidate type + pure RSS/HN/arXiv parsers"
```

---

## Task 4: Gate 1 — cheap batch prescore (`callLlmPrescore` + pure parser)

**Files:**
- Modify: `app/src/lib/llm.ts` — add `parsePrescoreScores()` (pure) + `callLlmPrescore()` (network), near the other `callLlm*` exports.
- Test: `app/scripts/discovery-prescore.test.ts`

- [ ] **Step 1: Write the failing test (pure parser only)**

```ts
// app/scripts/discovery-prescore.test.ts
import assert from "node:assert/strict";
import { parsePrescoreScores } from "../src/lib/llm";

// model returns {"scores":[...]} with exactly n entries
assert.deepEqual(parsePrescoreScores('{"scores":[0.8,0.1,0.55]}', 3), [0.8, 0.1, 0.55]);

// values are clamped to [0,1]
assert.deepEqual(parsePrescoreScores('{"scores":[1.5,-0.2]}', 2), [1, 0]);

// wrong length / junk → neutral 0.5 fallback for every item (fail-open: don't
// silently drop everything if the model misbehaves)
assert.deepEqual(parsePrescoreScores('{"scores":[0.9]}', 3), [0.5, 0.5, 0.5]);
assert.deepEqual(parsePrescoreScores("not json", 2), [0.5, 0.5]);

// tolerates a bare array too
assert.deepEqual(parsePrescoreScores("[0.2,0.3]", 2), [0.2, 0.3]);

console.log("discovery-prescore.test.ts passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm exec tsx scripts/discovery-prescore.test.ts`
Expected: FAIL — `parsePrescoreScores` not exported.

- [ ] **Step 3: Add the parser + call to `app/src/lib/llm.ts`**

```ts
/** Parse a gate-1 prescore response into exactly `n` clamped [0,1] scores.
 *  Fail-open: any shape mismatch yields a neutral 0.5 for every item so a
 *  flaky prescore never silently discards the whole batch. */
export function parsePrescoreScores(content: string, n: number): number[] {
  const neutral = () => Array.from({ length: n }, () => 0.5);
  let arr: unknown;
  try {
    const parsed = JSON.parse(content.trim());
    arr = Array.isArray(parsed) ? parsed : (parsed as { scores?: unknown }).scores;
  } catch {
    return neutral();
  }
  if (!Array.isArray(arr) || arr.length !== n) return neutral();
  return arr.map((v) => {
    const x = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(x)) return 0.5;
    return Math.max(0, Math.min(1, x));
  });
}

/** Gate 1: cheaply rank candidates by title+snippet only (no body fetch).
 *  One non-streaming chat call; returns a score in [0,1] per item, in order.
 *  Uses LLM_PRESCORE_MODEL if set, else the env default provider/model. */
export async function callLlmPrescore(
  env: LlmEnv,
  items: { title: string; snippet: string }[],
): Promise<number[]> {
  if (items.length === 0) return [];
  const provider = resolveProviderSpec(env, env.LLM_PRESCORE_MODEL);
  const list = items
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.snippet.slice(0, 200)}`)
    .join("\n");
  const system =
    "你是技术内容预筛器。只看标题和摘要，判断每条是否值得深入处理。" +
    "高质量=一线第一手技术报告/有数据有代码/有新论断；低质量=列表水文、PR、营销、AI 二次拼贴。" +
    `严格输出 JSON：{"scores":[...]}，数组长度必须等于 ${items.length}，每个值是 0-1 的小数。`;
  const res = await fetch(provider.baseUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 1000,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: list },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`prescore ${provider.name} ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  return parsePrescoreScores(content, items.length);
}
```

Add the optional field to the `LlmEnv` interface (`app/src/lib/llm.ts:33`), alongside `LLM_MODEL`:

```ts
  /** Optional cheap model spec for gate-1 discovery prescore (title+snippet).
   *  Defaults to the env default provider/model when unset. */
  LLM_PRESCORE_MODEL?: string;
```

> Note on streaming: the structured analysis/sections calls stream because their output is large and ModelScope needs it; the prescore output is tiny, so a non-streaming call is fine and simpler. If the configured provider rejects `stream:false` with `json_object`, set `LLM_PRESCORE_MODEL` to a DeepSeek/OpenAI spec. Verify against the local OpenAI-compatible SSE stub (see the "Verify LLM pipeline with local stub" note) before relying on the live provider.

- [ ] **Step 4: Run the prescore test + typecheck**

Run: `cd app && pnpm exec tsx scripts/discovery-prescore.test.ts && pnpm typecheck`
Expected: `discovery-prescore.test.ts passed`, typecheck clean.

- [ ] **Step 5: Commit**

```sh
git add app/src/lib/llm.ts app/scripts/discovery-prescore.test.ts
git commit -m "feat(discovery): gate 1 — batch prescore call + clamped parser"
```

---

## Task 5: Dedup + orchestration (`runDiscovery`) in `discovery.ts`

**Files:**
- Modify: `app/src/lib/discovery.ts` — add `partitionUnseen` (pure), `DiscoveryEnv`, `enqueueCandidate`, `runDiscovery`.
- Test: `app/scripts/discovery-dedup.test.ts`

- [ ] **Step 1: Write the failing test (pure dedup partition)**

```ts
// app/scripts/discovery-dedup.test.ts
import assert from "node:assert/strict";
import { partitionUnseen, type Candidate } from "../src/lib/discovery";

const c = (url: string, source = "auto:hn"): Candidate => ({ url, title: "t", snippet: "s", source });

// `known` is the set of already-normalized URLs (seen ∪ submissions ∪ picks).
// partitionUnseen dedups within the batch too (same normalized url twice).
{
  const cands = [c("https://x.example/a"), c("https://x.example/a?utm_source=z"), c("https://x.example/b")];
  // normalize fn collapses tracking params → first two share a key
  const norm = (u: string) => u.split("?")[0]!;
  const { fresh } = partitionUnseen(cands, new Set<string>(), norm);
  assert.equal(fresh.length, 2, "intra-batch dedup by normalized url");
}
{
  const cands = [c("https://x.example/a"), c("https://x.example/b")];
  const norm = (u: string) => u;
  const known = new Set(["https://x.example/a"]);
  const { fresh } = partitionUnseen(cands, known, norm);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.url, "https://x.example/b");
}

console.log("discovery-dedup.test.ts passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm exec tsx scripts/discovery-dedup.test.ts`
Expected: FAIL — `partitionUnseen` not exported.

- [ ] **Step 3: Append dedup + orchestration to `app/src/lib/discovery.ts`**

```ts
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
  if (keys.length) {
    const seenRows = await db.select({ u: discoverySeen.urlNormalized }).from(discoverySeen).where(inArray(discoverySeen.urlNormalized, keys));
    for (const r of seenRows) known.add(r.u);
    const subRows = await db.select({ u: submissions.url }).from(submissions).where(inArray(submissions.url, keys));
    for (const r of subRows) known.add(r.u);
    const pickRows = await db.select({ u: picks.url }).from(picks).where(inArray(picks.url, keys));
    for (const r of pickRows) known.add(r.u);
  }

  const { fresh, freshKeys } = partitionUnseen(candidates, known, normalizeUrl);
  if (fresh.length === 0) {
    console.log(`discovery: fetched=${fetched} fresh=0 (all known)`);
    return { fetched, fresh: 0, passedGate1: 0, enqueued: 0 };
  }

  // Record every fresh URL as seen NOW — even ones gate 1 will drop — so we
  // never re-score them on the next tick.
  await db.insert(discoverySeen)
    .values(fresh.map((c, i) => ({ urlNormalized: freshKeys[i]!, source: c.source })))
    .onConflictDoNothing();

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
```

- [ ] **Step 4: Run the dedup test + typecheck**

Run: `cd app && pnpm exec tsx scripts/discovery-dedup.test.ts && pnpm typecheck`
Expected: `discovery-dedup.test.ts passed`, typecheck clean.

> If typecheck flags the `~/` alias inside a file later imported by the worker, that's fine — the worker imports via relative path (Task 6); the `~/` alias resolves under the Astro app's tsconfig used by `pnpm typecheck`.

- [ ] **Step 5: Commit**

```sh
git add app/src/lib/discovery.ts app/scripts/discovery-dedup.test.ts
git commit -m "feat(discovery): dedup partition + runDiscovery orchestration"
```

---

## Task 6: The `discovery-consumer` worker (cron + adapters + config)

**Files:**
- Create: `app/workers/discovery-consumer/wrangler.toml`
- Create: `app/workers/discovery-consumer/src/sources.ts`
- Create: `app/workers/discovery-consumer/src/index.ts`

- [ ] **Step 1: Create the source config `app/workers/discovery-consumer/src/sources.ts`**

```ts
/** Discovery source configuration. Edit this file to change what gets watched.
 *  (A future iteration may move this into /admin; MVP keeps it in code.) */
export const FEEDS: { id: string; url: string }[] = [
  // id becomes the source tag "auto:rss:<id>". Add your trusted blogs here.
  { id: "rss:simonwillison", url: "https://simonwillison.net/atom/everything/" },
  { id: "rss:cloudflare", url: "https://blog.cloudflare.com/rss/" },
];

export const HN = {
  /** Only keep HN stories at/above this many points. */
  minPoints: 150,
  /** How many recent stories to scan per run. */
  hitsPerPage: 50,
};

export const ARXIV = {
  /** arXiv categories to scan, newest-first. */
  categories: ["cs.AI", "cs.LG", "cs.SE"],
  /** Max results per category per run. */
  maxResults: 20,
};
```

- [ ] **Step 2: Create the worker `app/workers/discovery-consumer/src/index.ts`**

```ts
/**
 * Glean discovery worker.
 *
 * scheduled() (cron, twice daily): pull candidates from RSS/HN/arXiv, dedup,
 * gate-1 prescore, and enqueue survivors to glean-ingest — feeding the SAME
 * pipeline /api/submit uses. Each adapter runs under its own try/catch so one
 * dead feed can't sink the run.
 *
 * fetch() POST /run : dev-only manual trigger (Pages/wrangler proxy).
 */
import { runDiscovery, parseFeed, parseHnHits, parseArxivXml, type Candidate, type DiscoveryEnv } from "../../../src/lib/discovery";
import { FEEDS, HN, ARXIV } from "./sources";

export interface Env extends DiscoveryEnv {}

async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, { headers: { accept, "user-agent": "glean-discovery/1.0" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function collect(): Promise<Candidate[]> {
  const all: Candidate[] = [];

  for (const feed of FEEDS) {
    try {
      const xml = await fetchText(feed.url, "application/rss+xml, application/atom+xml, application/xml");
      all.push(...parseFeed(xml, feed.id));
    } catch (err) {
      console.error("discovery feed fail", feed.id, (err as Error).message);
    }
  }

  try {
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=${HN.hitsPerPage}&numericFilters=points>=${HN.minPoints}`;
    const json = JSON.parse(await fetchText(url, "application/json")) as { hits?: unknown[] };
    all.push(...parseHnHits(json as never, HN.minPoints));
  } catch (err) {
    console.error("discovery hn fail", (err as Error).message);
  }

  for (const cat of ARXIV.categories) {
    try {
      const url = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}&sortBy=submittedDate&sortOrder=descending&max_results=${ARXIV.maxResults}`;
      all.push(...parseArxivXml(await fetchText(url, "application/atom+xml")));
    } catch (err) {
      console.error("discovery arxiv fail", cat, (err as Error).message);
    }
  }

  return all;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`discovery tick: cron="${controller.cron}"`);
    const candidates = await collect();
    const result = await runDiscovery(env, candidates);
    console.log(`discovery done: ${JSON.stringify(result)}`);
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      const candidates = await collect();
      const result = await runDiscovery(env, candidates);
      return new Response(JSON.stringify({ ok: true, result }, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("glean-discovery worker: POST /run", { status: 200 });
  },
};
```

- [ ] **Step 3: Create `app/workers/discovery-consumer/wrangler.toml`**

Copy the D1 + producer pattern from `app/workers/ingest-consumer/wrangler.toml` (same `database_id`). Discovery is a **producer** to `glean-ingest` (binding `INGEST`), needs `DB`, and the LLM secrets for gate 1.

```toml
name = "glean-discovery"
main = "src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

[[d1_databases]]
binding = "DB"
database_name = "glean"
database_id = "5cfae4b8-2c7a-459e-957b-8be7f451f13c"
migrations_dir = "../../migrations"

# Producer to the extract queue — same queue /api/submit enqueues to.
[[queues.producers]]
binding = "INGEST"
queue = "glean-ingest"

# Twice daily: 01:00 and 13:00 UTC (= 09:00 / 21:00 Asia/Shanghai).
[triggers]
crons = ["0 1,13 * * *"]

[dev]
port = 8789

# Secrets to set (wrangler secret put <NAME> -c workers/discovery-consumer/wrangler.toml):
#   MODELSCOPE_API_KEY  — gate-1 prescore (default provider)
#   DEEPSEEK_API_KEY / OPENAI_API_KEY — alternatives
#   LLM_PRESCORE_MODEL  — optional cheap-model spec for gate 1
```

- [ ] **Step 4: Typecheck**

Run: `cd app && pnpm typecheck`
Expected: clean. (If the worker's relative import depth is wrong, fix `../../../src/...` to match the existing workers — they use exactly three `../`.)

- [ ] **Step 5: Local dry-run of the worker**

Run, in `app/`, with the dev DB already migrated (Task 1, Step 5):
```sh
pnpm exec wrangler dev -c workers/discovery-consumer/wrangler.toml --port 8789 &
sleep 3
curl -s -X POST http://localhost:8789/run | head -40
```
Expected: JSON `{ "ok": true, "result": { "fetched": >0, "fresh": …, "passedGate1": …, "enqueued": … } }`. If `MODELSCOPE_API_KEY` isn't in `.dev.vars`, gate 1 fails-open (passes all) — that's acceptable for the dry-run; the count still flows. Kill the dev server after.

> Note: live network (real RSS/HN/arXiv) runs here. If offline, this step is informational — the pure parsers are already covered by Task 3 tests.

- [ ] **Step 6: Commit**

```sh
git add app/workers/discovery-consumer
git commit -m "feat(discovery): scheduled worker — adapters, cron (2x daily), dev /run"
```

---

## Task 7: Surface `screened` + `source` in `/admin`

**Files:**
- Modify: `app/src/pages/admin/index.astro:12-32` (filter keys/map) and the list rendering + counts; the `source` badge in the row markup.
- Modify: `app/src/components/StatusPill.astro` (add a `screened` case).

- [ ] **Step 1: Add `screened` to the admin filter model**

In `app/src/pages/admin/index.astro`, extend `FilterKey` and `FILTERS`:

```ts
type FilterKey = "active" | "ready" | "pending" | "published" | "rejected" | "failed" | "screened" | "all";
const FILTERS: Record<FilterKey, ("pending"|"analyzing"|"composing"|"ready"|"published"|"rejected"|"failed"|"screened")[]> = {
  active:    ["pending", "analyzing", "composing", "ready"],
  ready:     ["ready"],
  pending:   ["pending", "analyzing", "composing"],
  published: ["published"],
  rejected:  ["rejected"],
  failed:    ["failed"],
  screened:  ["screened"],
  all:       ["pending", "analyzing", "composing", "ready", "published", "rejected", "failed", "screened"],
};
```

And in the `filterKey` resolver, add a branch alongside the others:

```ts
  if (filterParam in FILTERS) return filterParam as FilterKey;
```
(already covers `?status=screened` — confirm no extra branch needed; the backwards-compat block below only handles legacy single-status links, so `screened` works via the `in FILTERS` check.)

`isFlatList` is `filterKey !== "active" && filterKey !== "ready"`, so `screened` automatically gets the paginated flat-list query + search + sort. No further query change needed.

- [ ] **Step 2: Add the `screened` tab + count**

Find the filter nav markup (the row of `<a>` tabs that call `tabCount(...)`). Add a tab between `failed` and `all`:

```astro
<a href="/admin?status=screened" class={filterKey === "screened" ? "tab tab--on" : "tab"}>
  Screened <span class="tab-n">{tabCount("screened")}</span>
</a>
```
(Match the exact class names / markup of the sibling tabs in this file.)

- [ ] **Step 3: Show the `source` origin on each row**

In the row template, where the submitter / host is rendered, add a small badge when `row.source` starts with `auto:`:

```astro
{row.source?.startsWith("auto:") && (
  <span class="src-badge" title={row.source}>via {row.source.replace(/^auto:/, "")}</span>
)}
```
Add a minimal style in the page's `<style>` block:
```css
.src-badge { font-size: 11px; color: var(--c-muted); border: 1px solid var(--c-border); border-radius: 4px; padding: 0 4px; margin-left: 6px; }
```

- [ ] **Step 4: Handle `screened` in `StatusPill.astro`**

Open `app/src/components/StatusPill.astro` and add a `screened` branch wherever it maps status → label/color (mirror the `rejected`/`failed` cases). Label it `Screened` with a muted/amber tone distinct from `rejected`.

- [ ] **Step 5: Typecheck + verify the tab renders**

Run: `cd app && pnpm typecheck`
Expected: clean. Then, with `pnpm dev` running, open `http://localhost:4321/admin?status=screened` with header `x-glean-admin-dev: 1` and confirm the page loads (empty list is fine until a screened row exists).

- [ ] **Step 6: Commit**

```sh
git add app/src/pages/admin/index.astro app/src/components/StatusPill.astro
git commit -m "feat(admin): surface 'screened' filter + auto-discovery source badge"
```

---

## Task 8: End-to-end local verification + docs

**Files:**
- Modify: `app/README.md` (document the new worker + cache/deploy note), `CLAUDE.md` (add discovery worker to the "three surfaces" / deploy list).

- [ ] **Step 1: Run the full test suite**

Run:
```sh
cd app && for f in scripts/*.test.ts; do pnpm exec tsx "$f" || { echo "FAILED: $f"; break; }; done
```
Expected: every file prints its `passed` line; none exit non-zero. The new files are `discovery-schema`, `discovery-gate`, `discovery-parsers`, `discovery-prescore`, `discovery-dedup`.

- [ ] **Step 2: Gate-2 end-to-end smoke (local, no real LLM needed)**

With the dev DB migrated, insert one fake auto submission with a low score directly to prove the gate path renders, then confirm it shows under `screened`:
```sh
DB=$(find app/.wrangler -name "*.sqlite" -path "*D1*" | head -1)
sqlite3 "$DB" "INSERT INTO submissions (id,url,source,status,ai_score,reject_reason,created_at) VALUES ('TESTSCREEN01','https://example.com/lowq','auto:hn','screened',0.5,'auto-screened: phase-1 score 0.50 < 0.7', strftime('%s','now'));"
```
Open `http://localhost:4321/admin?status=screened` (with the dev admin header) → the row appears with the `via hn` badge and a `Screened` pill. Then clean up:
```sh
sqlite3 "$DB" "DELETE FROM submissions WHERE id='TESTSCREEN01';"
```

- [ ] **Step 3: Document the new surface**

In `app/README.md`, add `glean-discovery` to the workers list and a deploy line:
```sh
pnpm wrangler deploy -c workers/discovery-consumer/wrangler.toml   # discovery: scheduled source watcher
```
In `CLAUDE.md` under "Deploy — three independent surfaces", note discovery is a **fourth** independent surface (cron worker; deploy only when `discovery.ts`, `sources.ts`, or the worker changes — and since it imports `src/lib/discovery.ts` which imports `ingest.ts`, redeploy it alongside the LLM/ingest workers when `ingest.ts` changes).

- [ ] **Step 4: Final typecheck + commit**

```sh
cd app && pnpm typecheck
git add app/README.md ../CLAUDE.md
git commit -m "docs(discovery): document the discovery worker + deploy surface"
```

---

## Deploy (after merge — not part of TDD loop)

```sh
cd app
# 1. Migrate remote D1 (the table rebuild):
pnpm wrangler d1 migrations apply glean --remote
# 2. Pages (admin UI changes):
pnpm build && pnpm wrangler pages deploy ./dist
# 3. ingest.ts changed → redeploy both queue workers:
pnpm wrangler deploy -c workers/ingest-consumer/wrangler.toml
pnpm wrangler deploy -c workers/llm-consumer/wrangler.toml
# 4. The new discovery worker:
pnpm wrangler deploy -c workers/discovery-consumer/wrangler.toml
# 5. Secrets for discovery (at least the prescore provider key):
pnpm wrangler secret put MODELSCOPE_API_KEY -c workers/discovery-consumer/wrangler.toml
```

## Out of scope (future, separate plans)
- X/Twitter and Reddit adapters.
- A "promote" action to manually run phase 2 on a `screened` row (reuse the existing sections-regeneration enqueue; deferred to keep this plan focused — screened rows are visible now, which was the confirmed requirement).
- Moving the source list into an `/admin` management UI.
- Threshold tuning (`0.7` / `0.4`) once real run data accrues.

## Self-review notes
- **Spec coverage:** RSS+HN+arXiv (Tasks 3/6) ✓; two gates (Task 2 gate-2, Task 4 gate-1, wired in Task 5) ✓; twice-daily cron (Task 6) ✓; screened visible in /admin (Task 7) ✓; dedup table (Tasks 1/5) ✓; source-in-config (Task 6) ✓; failure visibility / honest states (Task 2 logEvent + screened reason, Task 5 per-source try/catch) ✓.
- **Type consistency:** `Candidate` / `DiscoveryEnv` defined in Task 3/5 and consumed in Task 6; `shouldScreenAuto` / `AUTO_PUBLISH_SCORE_THRESHOLD` defined in Task 2 and used by its own test; `parsePrescoreScores` defined Task 4, used by `callLlmPrescore`; `LlmStageResult.status` union widened in Task 2 to match the screened return.
- **CHECK-constraint risk** (the highest-risk item) is handled head-on in Task 1 via the verified full-table rebuild, mirroring migrations 0008/0014.
