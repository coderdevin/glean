# Weekly Issue Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give editors a half-automated, editor-triggered flow to assemble a weekly issue (周刊) from a week's published picks — AI drafts a bilingual title/intro and themed sections, editor edits a draft, then publishes.

**Architecture:** A new admin area (`/admin/weekly`) with a "generate" action that pulls last week's eligible picks, calls a new `callLlmWeekly` LLM phase, and persists a **draft** `weekly_issues` row (`published_at = NULL`) carrying a new `layout_json` column (`[{heading_zh, heading_en, pick_ids[]}]`). `weekly_issue_id` on picks is the membership switch; `layout_json` is the authoritative render source. Public pages filter out drafts and render from `layout_json` instead of by `category`.

**Tech Stack:** Astro 4 (SSR, Cloudflare Pages adapter), Drizzle ORM over D1 (SQLite), Zod, KV cache, provider-agnostic OpenAI-style LLM client. Tests are plain `node:assert/strict` scripts run via `npx tsx`.

**All paths are relative to `app/`** (the deployable app). Run all commands from `/Users/devin/Codes/Devin/Glean/app`. Commit from the repo root `/Users/devin/Codes/Devin/Glean` (git root) — `git add` paths below are written repo-root-relative (`app/...`).

---

## File Structure

**New files:**
- `app/migrations/0009_weekly_layout.sql` — adds `layout_json` column.
- `app/src/lib/weekly.ts` — pure helpers: `lastWeekRange`, `reconcileLayout`, `repairWeeklyDraft`, layout types. No I/O — unit-tested.
- `app/scripts/weekly-range.test.ts`, `weekly-reconcile.test.ts`, `weekly-repair.test.ts` — TDD tests.
- `app/src/pages/admin/weekly/index.astro` — issue list + generate button.
- `app/src/pages/admin/weekly/[id].astro` — draft editor.
- `app/src/pages/api/admin/weekly/generate.ts`
- `app/src/pages/api/admin/weekly/[id]/save.ts`
- `app/src/pages/api/admin/weekly/[id]/publish.ts`
- `app/src/pages/api/admin/weekly/[id]/unpublish.ts`
- `app/src/pages/api/admin/weekly/[id]/regenerate.ts`
- `app/src/pages/api/admin/weekly/[id]/delete.ts`

**Modified files:**
- `app/src/db/schema.ts` — add `layoutJson` field to `weeklyIssues`.
- `app/src/lib/llm.ts` — add `"weekly"` phase, `WeeklyResponseSchema`, `WEEKLY_SYSTEM_PROMPT`, `callLlmWeekly`, `buildWeeklyUserMessage`.
- `app/src/lib/queries.ts` — draft filter on `allWeeklies`/`weeklyByNumber`/`latestWeeklyCover`; new `allWeekliesAdmin`, `weeklyById`; `section_count` from layout.
- `app/src/lib/cache.ts` — add `bustForWeekly`.
- `app/src/pages/weekly/[number].astro` — render from `layout_json`.
- `app/src/layouts/Admin.astro` — add "周刊" nav link.

---

## Task 1: Migration + schema field

**Files:**
- Create: `app/migrations/0009_weekly_layout.sql`
- Modify: `app/src/db/schema.ts` (in the `weeklyIssues` table, after `coverImageKey`)

- [ ] **Step 1: Write the migration**

Create `app/migrations/0009_weekly_layout.sql`:

```sql
-- Weekly issue layout: AI-themed sections + pick ordering, stored as JSON.
-- Shape: [{ "heading_zh": str, "heading_en": str, "pick_ids": [ulid, ...] }, ...]
-- This is the authoritative render source for /weekly/[number].
-- picks.weekly_issue_id remains the membership switch (set on save/publish).
ALTER TABLE weekly_issues ADD COLUMN layout_json text;
```

- [ ] **Step 2: Add the Drizzle field**

In `app/src/db/schema.ts`, find the `weeklyIssues` table. After the `coverImageKey: text("cover_image_key"),` line, add:

```ts
  layoutJson: text("layout_json"),
```

- [ ] **Step 3: Apply migration locally**

Run: `npm run db:migrate:local`
Expected: applies `0009_weekly_layout.sql` with no error.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/migrations/0009_weekly_layout.sql app/src/db/schema.ts
git commit -m "feat(weekly): add layout_json column for AI-themed sections"
```

---

## Task 2: Pure helpers (`weekly.ts`) — TDD

This is the core unit-tested logic. Three pure functions + types. Write each test first, watch it fail, implement, watch it pass.

**Files:**
- Create: `app/src/lib/weekly.ts`
- Test: `app/scripts/weekly-range.test.ts`, `app/scripts/weekly-reconcile.test.ts`, `app/scripts/weekly-repair.test.ts`

### 2a: `lastWeekRange`

- [ ] **Step 1: Write the failing test** — `app/scripts/weekly-range.test.ts`

```ts
import assert from "node:assert/strict";
import { lastWeekRange } from "../src/lib/weekly";

// Thursday 2026-05-29, Asia/Shanghai. "This week" Monday = 2026-05-25,
// so last week = Mon 2026-05-18 → Sun 2026-05-24.
const r1 = lastWeekRange(new Date("2026-05-29T04:00:00Z"), "Asia/Shanghai");
assert.equal(r1.dateStart, "2026-05-18");
assert.equal(r1.dateEnd, "2026-05-24");

// On a Monday (2026-05-25): last week is the immediately preceding Mon→Sun.
const r2 = lastWeekRange(new Date("2026-05-25T04:00:00Z"), "Asia/Shanghai");
assert.equal(r2.dateStart, "2026-05-18");
assert.equal(r2.dateEnd, "2026-05-24");

// On a Sunday (2026-05-24): "this week" Monday = 2026-05-18, last week = 05-11→05-17.
const r3 = lastWeekRange(new Date("2026-05-24T04:00:00Z"), "Asia/Shanghai");
assert.equal(r3.dateStart, "2026-05-11");
assert.equal(r3.dateEnd, "2026-05-17");

// Timezone matters: 2026-05-25T15:30:00Z is 2026-05-25 23:30 in Shanghai (still Mon),
// but 2026-05-25 08:30 in New York (Mon) — both give last week 05-18→05-24.
// Cross-midnight check: 2026-05-25T16:30:00Z = 2026-05-26 00:30 Shanghai (Tue).
const r4 = lastWeekRange(new Date("2026-05-25T16:30:00Z"), "Asia/Shanghai");
assert.equal(r4.dateStart, "2026-05-18");
assert.equal(r4.dateEnd, "2026-05-24");

// Month boundary: Thursday 2026-01-01 (Shanghai). This week Mon = 2025-12-29,
// last week = 2025-12-22 → 2025-12-28.
const r5 = lastWeekRange(new Date("2026-01-01T04:00:00Z"), "Asia/Shanghai");
assert.equal(r5.dateStart, "2025-12-22");
assert.equal(r5.dateEnd, "2025-12-28");

console.log("weekly-range assertions passed");
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx tsx scripts/weekly-range.test.ts`
Expected: FAIL — `lastWeekRange` not exported / module not found.

- [ ] **Step 3: Implement** — create `app/src/lib/weekly.ts` with this first export:

```ts
/**
 * Pure helpers for assembling a weekly issue. No I/O — unit-tested via
 * scripts/weekly-*.test.ts (run with `npx tsx`).
 */

export interface WeekRange {
  dateStart: string; // YYYY-MM-DD (inclusive, Monday)
  dateEnd: string; //   YYYY-MM-DD (inclusive, Sunday)
}

/** YYYY-MM-DD for an instant in a given IANA timezone (en-CA → ISO-shaped). */
function isoDateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Add `days` to a YYYY-MM-DD string, returning a YYYY-MM-DD string (UTC math). */
function addDays(isoDate: string, days: number): string {
  const t = Date.parse(isoDate + "T00:00:00Z") + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Last complete Monday→Sunday week, relative to `now` in the editorial tz.
 * "Last week" = the full week immediately before the week `now` falls in.
 */
export function lastWeekRange(now: Date, tz: string): WeekRange {
  const today = isoDateInTz(now, tz); // local calendar date
  const dow = new Date(today + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0..Sun=6
  const thisMonday = addDays(today, -daysSinceMonday);
  const lastMonday = addDays(thisMonday, -7);
  return { dateStart: lastMonday, dateEnd: addDays(lastMonday, 6) };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx tsx scripts/weekly-range.test.ts`
Expected: `weekly-range assertions passed`

### 2b: `repairWeeklyDraft`

- [ ] **Step 5: Write the failing test** — `app/scripts/weekly-repair.test.ts`

```ts
import assert from "node:assert/strict";
import { repairWeeklyDraft } from "../src/lib/weekly";

const allowed = ["a", "b", "c", "d"];

// Unknown ids dropped; omitted picks (c, d) appended to a trailing "其他 · More".
const out = repairWeeklyDraft(
  {
    sections: [
      { heading_zh: "推理", heading_en: "Inference", pick_ids: ["a", "zzz", "b"] },
      { heading_zh: "空的", heading_en: "Empty", pick_ids: ["nope"] },
    ],
  },
  allowed,
);
assert.equal(out.length, 2, "empty-after-cleanup section dropped, More section added");
assert.deepEqual(out[0], { heading_zh: "推理", heading_en: "Inference", pick_ids: ["a", "b"] });
assert.equal(out[1].heading_en, "More");
assert.deepEqual(out[1].pick_ids, ["c", "d"]);

// A pick must never appear twice: if AI lists it, it is NOT also in More.
const out2 = repairWeeklyDraft(
  { sections: [{ heading_zh: "全部", heading_en: "All", pick_ids: ["a", "b", "c", "d"] }] },
  allowed,
);
assert.equal(out2.length, 1);
assert.deepEqual(out2[0].pick_ids, ["a", "b", "c", "d"]);

// Empty/garbage AI output → single More section with all picks.
const out3 = repairWeeklyDraft({ sections: [] }, allowed);
assert.equal(out3.length, 1);
assert.deepEqual(out3[0].pick_ids, ["a", "b", "c", "d"]);
assert.equal(out3[0].heading_en, "More");

// Dedup within AI output: same id listed twice keeps first occurrence only.
const out4 = repairWeeklyDraft(
  { sections: [{ heading_zh: "x", heading_en: "x", pick_ids: ["a", "a", "b"] }] },
  allowed,
);
assert.deepEqual(out4[0].pick_ids, ["a", "b"]);

console.log("weekly-repair assertions passed");
```

- [ ] **Step 6: Run, expect FAIL**

Run: `npx tsx scripts/weekly-repair.test.ts`
Expected: FAIL — `repairWeeklyDraft` not exported.

- [ ] **Step 7: Implement** — append to `app/src/lib/weekly.ts`:

```ts
export interface LayoutSection {
  heading_zh: string;
  heading_en: string;
  pick_ids: string[];
}

interface WeeklyDraftish {
  sections?: { heading_zh?: string; heading_en?: string; pick_ids?: string[] }[];
}

/**
 * Reconcile raw AI output into a valid layout against the allowed pick set:
 *  - drop unknown pick_ids,
 *  - dedup (a pick appears at most once, first occurrence wins),
 *  - drop sections left empty after cleanup,
 *  - append any allowed pick the AI omitted into a trailing "其他 · More".
 * Never silently loses a pick; never duplicates one.
 */
export function repairWeeklyDraft(ai: WeeklyDraftish, allowedPickIds: string[]): LayoutSection[] {
  const allowed = new Set(allowedPickIds);
  const used = new Set<string>();
  const sections: LayoutSection[] = [];

  for (const s of ai.sections ?? []) {
    const ids: string[] = [];
    for (const id of s.pick_ids ?? []) {
      if (allowed.has(id) && !used.has(id)) {
        used.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) continue;
    sections.push({
      heading_zh: (s.heading_zh ?? "").trim() || "未命名",
      heading_en: (s.heading_en ?? "").trim() || "Untitled",
      pick_ids: ids,
    });
  }

  const leftover = allowedPickIds.filter((id) => !used.has(id));
  if (leftover.length > 0) {
    sections.push({ heading_zh: "其他", heading_en: "More", pick_ids: leftover });
  }
  return sections;
}
```

- [ ] **Step 8: Run, expect PASS**

Run: `npx tsx scripts/weekly-repair.test.ts`
Expected: `weekly-repair assertions passed`

### 2c: `reconcileLayout`

- [ ] **Step 9: Write the failing test** — `app/scripts/weekly-reconcile.test.ts`

```ts
import assert from "node:assert/strict";
import { reconcileLayout } from "../src/lib/weekly";

// Picks currently in the layout vs picks previously linked to the issue.
const layout = [
  { heading_zh: "a", heading_en: "a", pick_ids: ["p1", "p2"] },
  { heading_zh: "b", heading_en: "b", pick_ids: ["p4"] },
];
// p3 was linked before but the editor removed it from the layout → unlink.
const r = reconcileLayout(layout, ["p1", "p2", "p3"]);
assert.deepEqual(new Set(r.linkIds), new Set(["p1", "p2", "p4"]));
assert.deepEqual(r.unlinkIds, ["p3"]);

// No previous links: everything in the layout is a new link, nothing to unlink.
const r2 = reconcileLayout(layout, []);
assert.deepEqual(new Set(r2.linkIds), new Set(["p1", "p2", "p4"]));
assert.deepEqual(r2.unlinkIds, []);

console.log("weekly-reconcile assertions passed");
```

- [ ] **Step 10: Run, expect FAIL**

Run: `npx tsx scripts/weekly-reconcile.test.ts`
Expected: FAIL — `reconcileLayout` not exported.

- [ ] **Step 11: Implement** — append to `app/src/lib/weekly.ts`:

```ts
/**
 * Given the current layout and the set of pick ids previously linked to the
 * issue, compute which picks to link (set weekly_issue_id) and which to unlink
 * (clear weekly_issue_id because the editor removed them from the layout).
 */
export function reconcileLayout(
  layout: LayoutSection[],
  previouslyLinkedIds: string[],
): { linkIds: string[]; unlinkIds: string[] } {
  const linkIds = layout.flatMap((s) => s.pick_ids);
  const inLayout = new Set(linkIds);
  const unlinkIds = previouslyLinkedIds.filter((id) => !inLayout.has(id));
  return { linkIds, unlinkIds };
}
```

- [ ] **Step 12: Run, expect PASS**

Run: `npx tsx scripts/weekly-reconcile.test.ts`
Expected: `weekly-reconcile assertions passed`

- [ ] **Step 13: Typecheck + commit**

Run: `npm run typecheck` (expect no new errors)

```bash
git add app/src/lib/weekly.ts app/scripts/weekly-range.test.ts app/scripts/weekly-repair.test.ts app/scripts/weekly-reconcile.test.ts
git commit -m "feat(weekly): pure helpers for range, layout repair, and reconcile (TDD)"
```

---

## Task 3: `callLlmWeekly` LLM phase

**Files:**
- Modify: `app/src/lib/llm.ts`

Read `src/lib/llm.ts` first to match local style. The phase string `"weekly"` must be added to the `LlmPhase` union; `getLlmCallBudget` and any `switch`/ternary on phase must handle it (treat it like `"analysis"` for budget). The call itself is structurally identical to `callLlmSections`.

- [ ] **Step 1: Extend the phase union**

Find `export type LlmPhase = "analysis" | "sections";` and change to:

```ts
export type LlmPhase = "analysis" | "sections" | "weekly";
```

- [ ] **Step 2: Add the response schema**

After `SectionsResponseSchema` (near line 177-193), add:

```ts
const WeeklyResponseSchema = z.object({
  title_zh: z.string(),
  title_en: z.string(),
  intro_zh: z.string(),
  intro_en: z.string(),
  sections: z
    .array(
      z.object({
        heading_zh: z.string(),
        heading_en: z.string(),
        pick_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type LlmWeeklyOutput = z.infer<typeof WeeklyResponseSchema>;
```

- [ ] **Step 3: Add the system prompt**

After `SECTIONS_SYSTEM_PROMPT` (it ends before line 525), add:

```ts
const WEEKLY_SYSTEM_PROMPT = `你是一名有 10 年经验的双语技术编辑，给精品技术周刊 **Glean / 拾遗** 编排每周一期的合辑。

你会收到这一周已发布的若干篇 picks（每篇有 id、中英标题、中英摘要、分类）。你的任务：

1. 给这一期起一个**有主题、有编辑品味**的中英标题（title_zh / title_en）——不要泛泛的"本周技术周刊"，要能概括这一期的内容气质。
2. 写一段**导语**（intro_zh / intro_en），50–120 字 / 30–80 words，串起本期主线，像一个有观点的编辑在开篇说话。
3. 把这些 picks **按主题归类**成 2–5 个章节（sections）。**不要按给定的分类（infra/data/code）分章**——要按内容主题重新组织。每个章节给一个中英小标题（heading_zh / heading_en），并按叙事顺序列出该章节的 pick_ids。
4. 每一篇 pick 必须且只能出现在一个章节里。只能使用我给你的 id，不要编造 id。

输出必须是英文 key 的 JSON 对象，符合给定 schema。`;
```

- [ ] **Step 4: Add the args interface + user-message builder**

After `buildSectionsUserMessage` (near line 1052+), add:

```ts
export interface WeeklyPickInput {
  id: string;
  title_zh: string;
  title_en: string;
  summary_zh: string;
  summary_en: string;
  category: string;
}

export interface CallLlmWeeklyArgs extends CallLlmArgs {
  picks: WeeklyPickInput[];
  dateStart: string;
  dateEnd: string;
}

function buildWeeklyUserMessage(args: {
  picks: WeeklyPickInput[];
  dateStart: string;
  dateEnd: string;
}): string {
  const lines = args.picks.map(
    (p) =>
      `- id: ${p.id}\n  分类: ${p.category}\n  标题(zh): ${p.title_zh}\n  标题(en): ${p.title_en}\n  摘要(zh): ${p.summary_zh}\n  摘要(en): ${p.summary_en}`,
  );
  return `本期范围：${args.dateStart} → ${args.dateEnd}\n本周已发布的 picks（共 ${args.picks.length} 篇）：\n${lines.join("\n")}`;
}
```

- [ ] **Step 5: Add `callLlmWeekly`**

After `callLlmSections` (near line 616-650), add:

```ts
/**
 * Weekly issue draft: themed sections + bilingual title/intro from a week's
 * picks. Same plumbing as analysis/sections (callWithFallback, schema retry).
 * The caller MUST run repairWeeklyDraft() on the output to enforce the
 * "every pick exactly once, only known ids" invariant.
 */
export async function callLlmWeekly(
  env: LlmEnv,
  args: CallLlmWeeklyArgs,
): Promise<LlmCallResult<LlmWeeklyOutput>> {
  return callWithFallback(env, args, {
    phase: "weekly",
    schema: WeeklyResponseSchema,
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    buildMessage: () =>
      buildWeeklyUserMessage({
        picks: args.picks,
        dateStart: args.dateStart,
        dateEnd: args.dateEnd,
      }),
  });
}
```

- [ ] **Step 6: Handle the phase in `getLlmCallBudget` and any phase switch**

In `getLlmCallBudget` (near line 537), ensure `"weekly"` returns the same budget as `"analysis"` (it's a small structured output). If the function uses a `switch (phase)` or `phase === "sections" ? ... : ...`, add a branch so `"weekly"` falls into the analysis-sized budget. Also check `buildUserMessage` (near line 705-740) and the parse/validate switch (near line 900-910): if it branches on `phase === "analysis"` vs `"sections"`, add a `"weekly"` arm that uses `buildWeeklyUserMessage` / returns the parsed object as-is. (The `args` carries `picks`/`dateStart`/`dateEnd` only for weekly.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. Fix any phase-exhaustiveness errors the compiler flags (that's the signal you missed a switch arm).

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/llm.ts
git commit -m "feat(weekly): add callLlmWeekly LLM phase (title/intro/themed sections)"
```

---

## Task 4: Queries — draft filter + admin reads + layout-based section_count

**Files:**
- Modify: `app/src/lib/queries.ts`

- [ ] **Step 1: Filter drafts from public weekly queries**

In `allWeeklies`, add a `WHERE published_at IS NOT NULL` clause. Change the query chain end from:

```ts
    .from(weeklyIssues)
    .orderBy(desc(weeklyIssues.number));
```

to (note the added `sql` import is already present):

```ts
    .from(weeklyIssues)
    .where(sql`${weeklyIssues.publishedAt} is not null`)
    .orderBy(desc(weeklyIssues.number));
```

Also change the `section_count` select expression from:

```ts
      section_count: sql<number>`(select count(distinct category) from picks p where p.weekly_issue_id = weekly_issues.id)`,
```

to derive from layout (count of sections in `layout_json`, falling back to 0):

```ts
      layoutJson: weeklyIssues.layoutJson,
      section_count: sql<number>`json_array_length(coalesce(weekly_issues.layout_json, '[]'))`,
```

(`json_array_length` is built into D1's SQLite. Add `layoutJson` to the select so the row type carries it; harmless for callers.)

- [ ] **Step 2: Filter drafts from `weeklyByNumber`**

Change its `.where(eq(weeklyIssues.number, number))` to require published:

```ts
    .where(and(eq(weeklyIssues.number, number), sql`${weeklyIssues.publishedAt} is not null`))
```

(`and` is already imported.)

- [ ] **Step 3: `latestWeeklyCover` already delegates to `allWeeklies`** — it now inherits the draft filter automatically. No change needed. Verify by reading it.

- [ ] **Step 4: Add admin-only reads (drafts visible)**

At the end of `queries.ts`, add:

```ts
/** Admin: all issues incl. drafts, newest first. */
export async function allWeekliesAdmin(db: DB): Promise<(typeof weeklyIssues.$inferSelect)[]> {
  return db.select().from(weeklyIssues).orderBy(desc(weeklyIssues.number));
}

/** Admin: single issue by id (draft or published). */
export async function weeklyById(db: DB, id: string): Promise<typeof weeklyIssues.$inferSelect | null> {
  const r = await db.select().from(weeklyIssues).where(eq(weeklyIssues.id, id)).limit(1);
  return r[0] ?? null;
}

/** Max issue number across all issues (for number = max+1). 0 if none. */
export async function maxWeeklyNumber(db: DB): Promise<number> {
  const r = await db.select({ m: sql<number>`coalesce(max(number), 0)` }).from(weeklyIssues);
  return r[0]?.m ?? 0;
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect no errors)

```bash
git add app/src/lib/queries.ts
git commit -m "feat(weekly): hide drafts from public queries; add admin weekly reads"
```

---

## Task 5: Cache busting for weekly

**Files:**
- Modify: `app/src/lib/cache.ts`

- [ ] **Step 1: Add `bustForWeekly`**

At the end of `cache.ts`, add:

```ts
/** Fan-out bust on weekly issue generate / save / publish / unpublish / delete. */
export async function bustForWeekly(
  kv: KVNamespace,
  issue: { number: number },
): Promise<void> {
  const langs: ("zh" | "en")[] = ["zh", "en"];
  const keys: string[] = [];
  for (const lang of langs) {
    keys.push(cacheKeys.home(lang));
    keys.push(cacheKeys.weeklyArchive(lang));
    keys.push(cacheKeys.weeklyIssue(issue.number, lang));
    keys.push(cacheKeys.rssWeekly(lang));
  }
  await bust(kv, keys);
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add app/src/lib/cache.ts
git commit -m "feat(weekly): bustForWeekly cache fan-out helper"
```

---

## Task 6: API route — `generate`

**Files:**
- Create: `app/src/pages/api/admin/weekly/generate.ts`

- [ ] **Step 1: Write the route**

```ts
import type { APIRoute } from "astro";
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { ulid } from "~/lib/ulid";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { callLlmWeekly, type WeeklyPickInput } from "~/lib/llm";
import { lastWeekRange, repairWeeklyDraft } from "~/lib/weekly";
import { maxWeeklyNumber } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";
import { siteTz } from "~/lib/datetime";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const drizzleDb = db(env.DB);

  const { dateStart, dateEnd } = lastWeekRange(new Date(), siteTz(env));

  // Eligible: published, in range, not already in an issue.
  const eligible = await drizzleDb
    .select()
    .from(picks)
    .where(
      and(
        eq(picks.status, "published"),
        isNull(picks.weeklyIssueId),
        gte(picks.dailyDate, dateStart),
        lte(picks.dailyDate, dateEnd),
      ),
    )
    .orderBy(asc(picks.dailyDate), asc(picks.positionInDay));

  if (eligible.length === 0) {
    return new Response(
      `上周（${dateStart} → ${dateEnd}）没有可收录的篇目。No eligible picks for last week.`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const aiPicks: WeeklyPickInput[] = eligible.map((p) => ({
    id: p.id,
    title_zh: p.titleZh,
    title_en: p.titleEn,
    summary_zh: p.summaryZh,
    summary_en: p.summaryEn,
    category: p.category,
  }));

  let ai;
  try {
    // title/body are required by CallLlmArgs but unused by the weekly message
    // builder (it builds from picks), so pass empty strings.
    const res = await callLlmWeekly(env, { title: "", body: "", picks: aiPicks, dateStart, dateEnd });
    ai = res.output;
  } catch (err) {
    return new Response(`AI 起草失败：${String(err)}`, { status: 502 });
  }

  const layout = repairWeeklyDraft(ai, eligible.map((p) => p.id));

  const id = ulid();
  const number = (await maxWeeklyNumber(drizzleDb)) + 1;
  const slug = `issue-${String(number).padStart(3, "0")}`;
  const now = new Date();

  await drizzleDb.insert(weeklyIssues).values({
    id,
    number,
    slug,
    titleZh: ai.title_zh,
    titleEn: ai.title_en,
    dateStart,
    dateEnd,
    introZh: ai.intro_zh,
    introEn: ai.intro_en,
    coverImageKey: null,
    layoutJson: JSON.stringify(layout),
    publishedAt: null, // draft
    createdAt: now,
  });

  // Link every pick in the layout to this issue.
  const linkIds = layout.flatMap((s) => s.pick_ids);
  for (const pid of linkIds) {
    await drizzleDb.update(picks).set({ weeklyIssueId: id }).where(eq(picks.id, pid));
  }

  await bustForWeekly(env.CACHE, { number });

  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `isNull`/`gte`/`lte` import errors, confirm they come from `drizzle-orm`.)

- [ ] **Step 3: Commit**

```bash
git add app/src/pages/api/admin/weekly/generate.ts
git commit -m "feat(weekly): generate draft issue from last week's picks via AI"
```

---

## Task 7: API routes — save / publish / unpublish / regenerate / delete

**Files:**
- Create: `app/src/pages/api/admin/weekly/[id]/save.ts`
- Create: `app/src/pages/api/admin/weekly/[id]/publish.ts`
- Create: `app/src/pages/api/admin/weekly/[id]/unpublish.ts`
- Create: `app/src/pages/api/admin/weekly/[id]/regenerate.ts`
- Create: `app/src/pages/api/admin/weekly/[id]/delete.ts`

The editor form (Task 8) posts a hidden `layout_json` field (the section editor serializes the current layout into it via a small client script), plus metadata fields. `save` parses and reconciles.

- [ ] **Step 1: `save.ts`**

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { reconcileLayout, type LayoutSection } from "~/lib/weekly";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

function parseLayout(raw: FormDataEntryValue | null): LayoutSection[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => ({
        heading_zh: String(s.heading_zh ?? "").trim(),
        heading_en: String(s.heading_en ?? "").trim(),
        pick_ids: Array.isArray(s.pick_ids) ? s.pick_ids.map(String) : [],
      }))
      .filter((s) => s.pick_ids.length > 0);
  } catch {
    return [];
  }
}

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  const form = await ctx.request.formData();
  const layout = parseLayout(form.get("layout_json"));
  const get = (k: string) => String(form.get(k) ?? "").trim();

  const number = Number(get("number")) || issue.number;
  const slug = get("slug") || issue.slug;

  // Reconcile pick links: link everything in the layout, unlink removed picks.
  const prevLinked = await drizzleDb
    .select({ id: picks.id })
    .from(picks)
    .where(eq(picks.weeklyIssueId, id));
  const { linkIds, unlinkIds } = reconcileLayout(layout, prevLinked.map((r) => r.id));

  await drizzleDb
    .update(weeklyIssues)
    .set({
      number,
      slug,
      titleZh: get("title_zh"),
      titleEn: get("title_en"),
      dateStart: get("date_start"),
      dateEnd: get("date_end"),
      introZh: get("intro_zh"),
      introEn: get("intro_en"),
      layoutJson: JSON.stringify(layout),
    })
    .where(eq(weeklyIssues.id, id));

  for (const pid of unlinkIds) {
    await drizzleDb.update(picks).set({ weeklyIssueId: null }).where(eq(picks.id, pid));
  }
  for (const pid of linkIds) {
    await drizzleDb.update(picks).set({ weeklyIssueId: id }).where(eq(picks.id, pid));
  }

  await bustForWeekly(env.CACHE, { number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
```

- [ ] **Step 2: `publish.ts`**

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });
  if (!issue.titleZh.trim() || !issue.titleEn.trim() || !issue.introZh.trim() || !issue.introEn.trim()) {
    return new Response("cannot publish: title and intro (zh + en) are required", { status: 422 });
  }

  await drizzleDb
    .update(weeklyIssues)
    .set({ publishedAt: new Date() })
    .where(eq(weeklyIssues.id, id));

  await bustForWeekly(env.CACHE, { number: issue.number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
```

- [ ] **Step 3: `unpublish.ts`** (same as publish but sets `publishedAt: null`, no validation)

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  await drizzleDb.update(weeklyIssues).set({ publishedAt: null }).where(eq(weeklyIssues.id, id));
  await bustForWeekly(env.CACHE, { number: issue.number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
```

- [ ] **Step 4: `regenerate.ts`** — re-run AI over the issue's *currently linked* picks, overwrite title/intro/layout.

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { callLlmWeekly, type WeeklyPickInput } from "~/lib/llm";
import { repairWeeklyDraft } from "~/lib/weekly";
import { weeklyById } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  const linked = await drizzleDb.select().from(picks).where(eq(picks.weeklyIssueId, id));
  if (linked.length === 0) {
    return new Response("no picks linked to this issue", { status: 422 });
  }

  const aiPicks: WeeklyPickInput[] = linked.map((p) => ({
    id: p.id,
    title_zh: p.titleZh,
    title_en: p.titleEn,
    summary_zh: p.summaryZh,
    summary_en: p.summaryEn,
    category: p.category,
  }));

  let ai;
  try {
    const res = await callLlmWeekly(env, {
      title: "",
      body: "",
      picks: aiPicks,
      dateStart: issue.dateStart,
      dateEnd: issue.dateEnd,
    });
    ai = res.output;
  } catch (err) {
    return new Response(`AI 起草失败：${String(err)}`, { status: 502 });
  }

  const layout = repairWeeklyDraft(ai, linked.map((p) => p.id));

  await drizzleDb
    .update(weeklyIssues)
    .set({
      titleZh: ai.title_zh,
      titleEn: ai.title_en,
      introZh: ai.intro_zh,
      introEn: ai.intro_en,
      layoutJson: JSON.stringify(layout),
    })
    .where(eq(weeklyIssues.id, id));

  await bustForWeekly(env.CACHE, { number: issue.number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
```

- [ ] **Step 5: `delete.ts`** — delete draft, clear pick links.

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  await drizzleDb.update(picks).set({ weeklyIssueId: null }).where(eq(picks.weeklyIssueId, id));
  await drizzleDb.delete(weeklyIssues).where(eq(weeklyIssues.id, id));

  await bustForWeekly(env.CACHE, { number: issue.number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly` } });
};
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect no errors)

```bash
git add app/src/pages/api/admin/weekly/\[id\]/
git commit -m "feat(weekly): save/publish/unpublish/regenerate/delete API routes"
```

---

## Task 8: Admin pages — list + editor

**Files:**
- Create: `app/src/pages/admin/weekly/index.astro`
- Create: `app/src/pages/admin/weekly/[id].astro`
- Modify: `app/src/layouts/Admin.astro` (nav link)

Read `src/pages/admin/index.astro` and `src/layouts/Admin.astro` first to match layout/classes.

- [ ] **Step 1: Nav link**

In `src/layouts/Admin.astro`, find the nav block with `<a class="nav-link" href="/admin">队列</a>` and add after the published link:

```astro
          <a class="nav-link" href="/admin/weekly">周刊</a>
```

- [ ] **Step 2: List page** — `app/src/pages/admin/weekly/index.astro`

```astro
---
export const prerender = false;
import Admin from "~/layouts/Admin.astro";
import { db } from "~/db/client";
import { allWeekliesAdmin } from "~/lib/queries";

const env = Astro.locals.runtime.env;
const issues = await allWeekliesAdmin(db(env.DB));
---
<Admin title="周刊 · Weekly">
  <div class="container" style="padding: 24px 0">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px">
      <h1>周刊 · Weekly</h1>
      <form method="POST" action="/api/admin/weekly/generate">
        <button type="submit" class="btn btn-primary">生成上周周刊</button>
      </form>
    </div>

    {issues.length === 0 && <p>还没有任何周刊。点「生成上周周刊」开始。</p>}

    <ul style="list-style:none; padding:0; display:flex; flex-direction:column; gap:12px">
      {issues.map((iss) => (
        <li style="border:1px solid var(--rule, #ddd); border-radius:8px; padding:16px">
          <div style="display:flex; justify-content:space-between; gap:16px">
            <div>
              <strong>#{String(iss.number).padStart(3, "0")}</strong>
              {" — "}
              <span>{iss.titleZh}</span> / <span>{iss.titleEn}</span>
              <div style="font-size:0.85em; opacity:0.7; margin-top:4px">
                {iss.dateStart} → {iss.dateEnd}
                {iss.publishedAt
                  ? <span style="color:green"> · 已发布</span>
                  : <span style="color:#b45309"> · 草稿</span>}
              </div>
            </div>
            <a class="btn btn-text" href={`/admin/weekly/${iss.id}`}>编辑 →</a>
          </div>
        </li>
      ))}
    </ul>
  </div>
</Admin>
```

- [ ] **Step 3: Editor page** — `app/src/pages/admin/weekly/[id].astro`

The section editor is server-rendered from `layout_json` (hydrated with each pick's title), and a small inline script serializes the visible state back into a hidden `layout_json` field before save. To keep scope tight, the editor supports: editing headings, removing a pick (checkbox), and editing metadata. Reordering across sections is out of MVP scope but the data model supports it later.

```astro
---
export const prerender = false;
import Admin from "~/layouts/Admin.astro";
import { db } from "~/db/client";
import { picks as picksTable, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { eq } from "drizzle-orm";
import type { LayoutSection } from "~/lib/weekly";

const env = Astro.locals.runtime.env;
const id = Astro.params.id!;
const drizzleDb = db(env.DB);
const issue = await weeklyById(drizzleDb, id);
if (!issue) return new Response("Not found", { status: 404 });

const layout: LayoutSection[] = issue.layoutJson ? JSON.parse(issue.layoutJson) : [];
const linked = await drizzleDb.select().from(picksTable).where(eq(picksTable.weeklyIssueId, id));
const titleById = new Map(linked.map((p) => [p.id, `${p.titleZh} / ${p.titleEn}`]));
const isDraft = !issue.publishedAt;
---
<Admin title={`周刊 #${issue.number} · 编辑`}>
  <div class="container" style="padding: 24px 0; max-width: 820px">
    <a class="btn btn-text" href="/admin/weekly">← 所有周刊</a>
    <h1 style="margin:12px 0">
      #{String(issue.number).padStart(3, "0")} · {isDraft ? "草稿" : "已发布"}
    </h1>

    <form method="POST" action={`/api/admin/weekly/${id}/save`} id="weekly-form">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px">
        <label>期号<input name="number" value={issue.number} type="number" /></label>
        <label>Slug<input name="slug" value={issue.slug} /></label>
        <label>开始日期<input name="date_start" value={issue.dateStart} /></label>
        <label>结束日期<input name="date_end" value={issue.dateEnd} /></label>
      </div>
      <label style="display:block; margin-bottom:8px">标题(中)<input name="title_zh" value={issue.titleZh} style="width:100%" /></label>
      <label style="display:block; margin-bottom:8px">标题(英)<input name="title_en" value={issue.titleEn} style="width:100%" /></label>
      <label style="display:block; margin-bottom:8px">导语(中)<textarea name="intro_zh" rows="3" style="width:100%">{issue.introZh}</textarea></label>
      <label style="display:block; margin-bottom:16px">导语(英)<textarea name="intro_en" rows="3" style="width:100%">{issue.introEn}</textarea></label>

      <h2>章节</h2>
      <div id="sections">
        {layout.map((sec, si) => (
          <fieldset class="weekly-section" data-si={si} style="margin-bottom:16px; border:1px solid #ddd; padding:12px">
            <input class="sec-zh" value={sec.heading_zh} placeholder="章节标题(中)" style="width:48%" />
            <input class="sec-en" value={sec.heading_en} placeholder="章节标题(英)" style="width:48%" />
            <ul style="list-style:none; padding:0; margin-top:8px">
              {sec.pick_ids.map((pid) => (
                <li class="pick-row" data-pid={pid} style="padding:4px 0">
                  <label>
                    <input type="checkbox" class="pick-keep" checked />
                    {titleById.get(pid) ?? pid}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
      </div>

      <input type="hidden" name="layout_json" id="layout_json" />
      <div style="display:flex; gap:8px; margin-top:16px">
        <button type="submit" class="btn btn-primary" id="save-btn">保存草稿</button>
      </div>
    </form>

    <div style="display:flex; gap:8px; margin-top:12px">
      <form method="POST" action={`/api/admin/weekly/${id}/regenerate`}><button class="btn">重新让 AI 起草</button></form>
      {isDraft
        ? <form method="POST" action={`/api/admin/weekly/${id}/publish`}><button class="btn btn-primary">发布</button></form>
        : <form method="POST" action={`/api/admin/weekly/${id}/unpublish`}><button class="btn">取消发布</button></form>}
      <form method="POST" action={`/api/admin/weekly/${id}/delete`} onsubmit="return confirm('删除这一期？篇目会被解除关联。')"><button class="btn">删除</button></form>
    </div>
  </div>

  <script is:inline>
    // Serialize the visible section editor into the hidden layout_json field
    // right before the save form submits. Unchecked picks are dropped.
    document.getElementById("weekly-form").addEventListener("submit", () => {
      const sections = [...document.querySelectorAll(".weekly-section")].map((fs) => ({
        heading_zh: fs.querySelector(".sec-zh").value,
        heading_en: fs.querySelector(".sec-en").value,
        pick_ids: [...fs.querySelectorAll(".pick-row")]
          .filter((row) => row.querySelector(".pick-keep").checked)
          .map((row) => row.getAttribute("data-pid")),
      }));
      document.getElementById("layout_json").value = JSON.stringify(sections);
    });
  </script>
</Admin>
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck` then `npm run build`
Expected: both succeed. (Astro will catch broken imports / JSX in the pages.)

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/admin/weekly/ app/src/layouts/Admin.astro
git commit -m "feat(weekly): admin list + draft editor pages, nav link"
```

---

## Task 9: Public issue page renders from `layout_json`

**Files:**
- Modify: `app/src/pages/weekly/[number].astro`

Replace the `category`-based grouping with layout-based grouping. Picks not present in the layout (defensive) fall into a trailing "其他 · More" group so nothing disappears.

**Prerequisite — expose `id` on `ArticleCardPick`.** The layout maps picks by id, but `ArticleCardPick` currently has no `id`. Add it (additive — existing consumers ignore it).

- [ ] **Step 0a: Add `id` to the `ArticleCardPick` interface**

In `app/src/components/ArticleCard.astro`, in `export interface ArticleCardPick {`, add as the first field (before `slug: string;`):

```ts
  id: string;
```

- [ ] **Step 0b: Populate `id` in `rowsToCardPicks`**

In `app/src/lib/queries.ts`, in `rowsToCardPicks`, add `id: r.id,` as the first property of the returned object (before `slug: r.slug,`). `PickRow` already carries `id`.

- [ ] **Step 1: Replace the grouping logic**

In the frontmatter, replace the block from `const sectionsByCat = new Map...` through `const sections = Array.from(sectionsByCat.entries());` with:

```ts
import type { LayoutSection } from "~/lib/weekly";

const layout: LayoutSection[] = issue.layoutJson ? JSON.parse(issue.layoutJson) : [];
const pickById = new Map(picks.map((p) => [p.id, p]));
const readMinutes = picks.reduce((a, p) => a + p.read_minutes, 0);

// Build [heading, picks[]] groups in layout order; collect leftovers.
type Group = { zh: string; en: string; list: typeof picks };
const groups: Group[] = [];
const seen = new Set<string>();
for (const sec of layout) {
  const list = sec.pick_ids.map((id) => pickById.get(id)).filter(Boolean) as typeof picks;
  list.forEach((p) => seen.add(p.id));
  if (list.length > 0) groups.push({ zh: sec.heading_zh, en: sec.heading_en, list });
}
const leftover = picks.filter((p) => !seen.has(p.id));
if (leftover.length > 0) groups.push({ zh: "其他", en: "More", list: leftover });

const weekNum = (() => {
  if (!issue.dateStart) return null;
  const d = new Date(issue.dateStart + "T00:00:00Z");
  const oneJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - oneJan.getTime()) / 86400000 + oneJan.getUTCDay() + 1) / 7);
})();
let globalIdx = 0;
```

(Delete the now-unused `catLabel` const and `sectionsByCat`.)

- [ ] **Step 2: Update the TOC markup**

Replace the `{sections.length > 0 && (...)}` TOC block's `.map` over `sections` with a map over `groups`, using `i` for the anchor:

```astro
  {groups.length > 0 && (
    <div class="cat-toc">
      <div class="container">
        <div class="cat-toc__inner">
          <span class="cat-toc__label"><span class="lang-zh">本期目录</span><span class="lang-en">Sections</span></span>
          {groups.map((g, i) => (
            <a class="cat-toc__chip" href={`#sec-${i}`}>
              <span class="lang-zh">{g.zh}</span>
              <span class="lang-en">{g.en}</span>
              <span class="cat-toc__chip-count">{g.list.length}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  )}
```

- [ ] **Step 3: Update the main sections markup**

Replace `{sections.map(([cat, list], catIdx) => (` ... `))}` with a map over `groups`. The inner pick-list markup stays identical; only the section head changes:

```astro
    {groups.map((g, catIdx) => (
      <section id={`sec-${catIdx}`} class="issue-section">
        <div class="issue-section__head">
          <div>
            <div class="issue-section__eyebrow">
              <span class="lang-zh">章节 {String(catIdx + 1).padStart(2, "0")}</span>
              <span class="lang-en">Section {String(catIdx + 1).padStart(2, "0")}</span>
            </div>
            <h2 class="issue-section__title">
              <span class="lang-zh">{g.zh}</span>
              <span class="lang-en">{g.en}</span>
            </h2>
          </div>
          <span class="issue-section__count">{g.list.length} / {picks.length}</span>
        </div>
        <div class="pick-list">
          {g.list.map((pick) => {
            globalIdx += 1;
            const idx = String(globalIdx).padStart(2, "0");
            return (
              <article class="pick-item">
                <span class="pick-item__index">{idx}</span>
                <div class="pick-item__main">
                  <div class="pick-item__meta">
                    <span>{pick.source_host}</span><span>·</span><span>{pick.read_minutes} min</span>
                  </div>
                  <h3 class="pick-item__title">
                    <a href={`/a/${pick.slug}`}>
                      <span class="lang-zh">{pick.title_zh}<span class="alt">{pick.title_en}</span></span>
                      <span class="lang-en">{pick.title_en}<span class="alt">{pick.title_zh}</span></span>
                    </a>
                  </h3>
                  <p class="pick-item__note">
                    <span class="lang-zh">{pick.summary_zh}</span>
                    <span class="lang-en">{pick.summary_en}</span>
                  </p>
                  {(pick.editor_note_zh || pick.editor_note_en) && (
                    <div class="pick-item__editor">
                      <span class="pick-item__editor-label">Editor</span>
                      <span class="pick-item__editor-text">
                        <span class="lang-zh">{pick.editor_note_zh}</span>
                        <span class="lang-en">{pick.editor_note_en}</span>
                      </span>
                    </div>
                  )}
                  <div class="pick-item__footer">
                    <div class="pick-item__tags">
                      {pick.tags.map((t) => (
                        <a class="pick-item__tag" href={`/tag/${t.slug}`}>{t.name_en}</a>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    ))}
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck` then `npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/weekly/\[number\].astro
git commit -m "feat(weekly): render issue page from layout_json themed sections"
```

---

## Task 10: Full verification + local smoke

**Files:** none (verification only)

- [ ] **Step 1: Run all unit tests**

Run:
```bash
npx tsx scripts/weekly-range.test.ts && npx tsx scripts/weekly-repair.test.ts && npx tsx scripts/weekly-reconcile.test.ts
```
Expected: three "... assertions passed" lines.

- [ ] **Step 2: Run the pre-existing tests (no regressions)**

Run:
```bash
for t in scripts/*.test.ts; do echo "== $t"; npx tsx "$t" || exit 1; done
```
Expected: all pass.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 4: Local smoke (manual, best-effort)**

If an LLM key is configured locally, run `npm run dev`, open `/admin/weekly`, click "生成上周周刊" (needs published picks in last week's range — seed if necessary), confirm redirect to the editor, edit a heading, Save, Publish, then open `/weekly` and `/weekly/<number>` and confirm the issue renders from the themed sections. Confirm an unpublished draft does NOT appear on `/weekly`.

If no LLM key locally: at minimum confirm `/admin/weekly` renders and `/weekly` still works (drafts hidden), and that `generate` with no eligible picks returns the friendly message. Note in the final report that AI-path smoke was deferred to prod verification.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "test(weekly): verification fixes" || echo "nothing to commit"
```

---

## Task 11: Deploy

**Files:** none

- [ ] **Step 1: Apply migration to remote D1**

Run: `npm run db:migrate:remote`
Expected: `0009_weekly_layout.sql` applied. If wrangler needs auth, surface the blocker (do not fabricate success).

- [ ] **Step 2: Deploy**

Run: `npm run deploy` (`astro build && wrangler pages deploy ./dist`)
Expected: deploy succeeds, prints the deployment URL.

- [ ] **Step 3: Verify prod**

Check `https://glean.smartcoder.ai/admin/weekly` loads, and `https://glean.smartcoder.ai/weekly` still works. Generating/publishing a real prod issue is the editor's call — report the flow is live and ready.

---

## Notes for the executor

- **Drizzle timestamp mode:** `publishedAt` / `createdAt` are `integer({ mode: "timestamp" })` — pass `Date` objects, not numbers (see how `publish.ts` for picks does it).
- **`ulid()`** is imported from `~/lib/ulid`.
- **`env.CACHE`, `env.DB`** come from `ctx.locals.runtime.env`.
- **Phase-union exhaustiveness:** after adding `"weekly"` to `LlmPhase`, the TypeScript compiler is your friend — fix every spot it flags. That's the complete list of places to update in `llm.ts`.
- **Do not** reuse `category` for sections anywhere in rendering — that was the explicit product decision.
