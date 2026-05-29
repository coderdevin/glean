# Weekly Issue Publishing — Design Spec

**Date:** 2026-05-29
**Status:** Approved (brainstorm complete)
**Topic:** Give editors a real way to assemble and publish a weekly issue (周刊) from the week's published picks.

## Problem

The `weekly_issues` table, the public `/weekly` list, and `/weekly/[number]` already exist, and `picks.weekly_issue_id` is defined + indexed — but **nothing in the code ever creates a weekly issue, links picks to it, or sets `published_at`.** Production has 0 weekly issues and 0 linked picks, so `https://glean.smartcoder.ai/weekly` is empty. The only way to publish an issue today is hand-written SQL.

Daily publishing is fully wired (`/api/admin/[id]/publish.ts`): editor reviews a submission, the status machine reaches `ready`, editor clicks Publish → a `pick` is created with `daily_date`. Weekly is the missing companion: bundling a week's picks into a themed, bilingual issue with an intro.

## Goal

A **half-automated, editor-triggered** weekly publishing flow:

1. Editor clicks **"生成上周周刊"** in admin.
2. System computes last week's Mon→Sun range (SITE_TZ), pulls that week's eligible picks, and calls the LLM to draft a bilingual title, intro, and **AI-themed sections** (custom section headings + pick ordering — **not** the existing `category` grouping).
3. The draft lands in the DB as a **draft issue** (`weekly_issues` row with `published_at = NULL`).
4. Editor edits issue metadata + sections in an admin editor page, then clicks **Publish** (sets `published_at`).

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| Trigger model | Half-auto, editor clicks a button. No cron. |
| Pick selection | Auto-pull the week's `published` picks not already in another issue; editor can deselect. |
| AI drafting | Bilingual title + intro **and** AI-themed section grouping / pick ordering. **Do not reuse `category` for sections.** No cover image. |
| Draft persistence | Persist as a draft `weekly_issues` row (`published_at = NULL`). Editor can leave and return. |
| Date range / number | Default to last Mon→Sun (SITE_TZ) + `number = max+1`; both editable. |
| Storage model | **JSON layout column** on `weekly_issues` (Option A), consistent with existing `sections_json` / `bullets_json` denormalized pattern. |

## Architecture

### Data flow

```
Editor at /admin/weekly clicks "生成上周周刊"
      │
      ▼
POST /api/admin/weekly/generate
  1. Compute last Mon→Sun [date_start, date_end] in SITE_TZ
  2. SELECT picks WHERE status='published' AND daily_date BETWEEN start AND end
       AND weekly_issue_id IS NULL          (picks already in another issue excluded)
  3. callLlmWeekly(picks) → { title_zh/en, intro_zh/en, sections[] }
  4. Repair LLM output: drop unknown pick_ids; append any omitted picks to a "其他 · More" section
  5. INSERT weekly_issues: number=max+1, slug="issue-NNN", date_start/end,
       AI title/intro, layout_json=sections, published_at=NULL   (DRAFT)
  6. UPDATE picks SET weekly_issue_id=<new id> for every pick in the layout
  7. 303 → /admin/weekly/<id>
      │
      ▼
Editor edits at /admin/weekly/[id]:
  number / slug / date_start / date_end / title_zh/en / intro_zh/en
  + section editor (section headings, deselect picks, reorder, move between sections)
      │
      ├─ Save draft → POST .../save        (persist fields + layout; reconcile pick links; bust)
      ├─ Re-draft   → POST .../regenerate   (re-run AI over current pick set)
      ├─ Publish    → POST .../publish      (validate non-empty; published_at=now; bust)
      ├─ Unpublish  → POST .../unpublish    (published_at=NULL; bust)
      └─ Delete     → POST .../delete       (delete draft; clear pick links; bust)
```

**Core invariant:** `weekly_issue_id` is the single switch for "which issue this pick belongs to"; `layout_json` is the authoritative render source for "what this issue looks like." On every save, the two are reconciled: every pick listed in the layout gets `weekly_issue_id = <issue>`; any pick previously linked but no longer in the layout has `weekly_issue_id` cleared. Linking a pick to an issue does **not** remove it from the daily archive (`daily_date` is untouched).

### Data model change — one column

`migrations/0009_weekly_layout.sql`:

```sql
ALTER TABLE weekly_issues ADD COLUMN layout_json text;
```

And the corresponding Drizzle field on `weeklyIssues` in `src/db/schema.ts`: `layoutJson: text("layout_json")`.

**`layout_json` shape** (stored as a JSON string):

```jsonc
[
  {
    "heading_zh": "大模型推理优化",
    "heading_en": "LLM Inference, Tuned",
    "pick_ids": ["01J...", "01J..."]
  },
  { "heading_zh": "其他", "heading_en": "More", "pick_ids": ["01J..."] }
]
```

`pick_ids` are ULIDs of picks linked to this issue, in render order. The weekly page renders sections in array order, picks in `pick_ids` order.

### AI drafting — `callLlmWeekly`

Add a new phase to `src/lib/llm.ts`, structurally identical to `callLlmAnalysis` / `callLlmSections` (uses the existing `callWithFallback`: provider abstraction, single retry on transient failure, Zod schema validation).

- **Input:** the selected picks as `{ id, title_zh, title_en, summary_zh, summary_en, category }`, plus the date range.
- **Output schema (Zod):**
  ```
  {
    title_zh: string, title_en: string,
    intro_zh: string, intro_en: string,
    sections: [ { heading_zh: string, heading_en: string, pick_ids: string[] } ]
  }
  ```
- **System prompt intent:** group picks by *theme* (ignore `category`), give the issue an editorially-tasteful bilingual theme title + one intro paragraph, bilingual section headings, ordering that reads as a narrative.
- **Robustness repair (pure function, unit-tested):** the LLM may only use pick_ids from the supplied set. After the call: drop unknown ids; append any picks the LLM omitted into a trailing **"其他 · More"** section. **Never silently drop a pick** — mirrors the existing "keep good sections rather than reject the batch" behavior in `callLlmSections`.

### Admin UI + API

Add a **"周刊"** link to the Admin nav (`src/layouts/Admin.astro`) → `/admin/weekly`.

**Pages (2):**
- `/admin/weekly` (`index.astro`) — "生成上周周刊" button at top; below it, a list of all issues (draft + published) with a `draft` marker on unpublished ones and an edit link per row.
- `/admin/weekly/[id]` (`[id].astro`) — the editor: metadata form (number / slug / dates / title_zh/en / intro_zh/en) + a section editor (section blocks each with bilingual heading and their picks; picks can be deselected, reordered, moved between sections); action buttons (Save draft / Re-draft / Publish / Unpublish / Delete).

**API routes** under `src/pages/api/admin/weekly/` (form-POST + Drizzle + 303 redirect, matching the existing admin API style):

| Route | Responsibility |
|---|---|
| `generate.ts` (POST) | Compute range → pull picks → `callLlmWeekly` → repair → INSERT draft + link picks → 303 to editor. Empty range → friendly "上周无可收录篇目", no empty issue created. |
| `[id]/save.ts` (POST) | Persist metadata + layout; reconcile `weekly_issue_id`; bust. |
| `[id]/publish.ts` (POST) | Validate title/intro non-empty (422 otherwise); `published_at=now`; bust. |
| `[id]/unpublish.ts` (POST) | `published_at=NULL` (back to draft); bust. |
| `[id]/regenerate.ts` (POST) | Re-run AI over current pick set; overwrite layout/title/intro. |
| `[id]/delete.ts` (POST) | Delete draft; clear those picks' `weekly_issue_id`; bust. |

### Public page changes + cache

- **Drafts must not leak:** add `published_at IS NOT NULL` filter to `allWeeklies`, `weeklyByNumber`, and `latestWeeklyCover` in `src/lib/queries.ts`. (Admin queries see all.)
- **`/weekly/[number]` render source:** change from "group by `category`" to "render `layout_json` sections in order"; each section uses its layout heading; picks looked up from the `picksForWeekly` result set, ordered by the layout's `pick_ids`. Picks present in `picksForWeekly` but missing from the layout (defensive) fall into a trailing group so nothing disappears.
- **`section_count` in `allWeeklies`:** currently `count(distinct category)`; change to count sections parsed from `layout_json` in JS (list page N is small).
- **Cache:** add `bustForWeekly(kv, { number, slug })` busting `/weekly`, `/weekly/<number>`, and the homepage cover key; reuse the existing `bust()`.

## Testing

The project's test convention is plain `node:assert/strict` scripts under `scripts/*.test.ts`, run via `npx tsx scripts/<name>.test.ts` (e.g. `scripts/reaper.test.ts`). No test framework to add. TDD: write the failing test first, then the pure function.

Pure functions to extract + unit-test (RED → GREEN):
- **`lastWeekRange(now, tz)`** → `{ dateStart, dateEnd }` for last Mon→Sun. Cover SITE_TZ offset and month boundaries.
- **`reconcileLayout(layout, previouslyLinkedIds)`** → `{ linkIds, unlinkIds }` after deselect/reorder.
- **`repairWeeklyDraft(aiOutput, allowedPickIds)`** → layout with unknown ids dropped and omitted picks appended to "其他 · More".

Test files: `scripts/weekly-range.test.ts`, `scripts/weekly-reconcile.test.ts`, `scripts/weekly-repair.test.ts`.

Type + build gates: `npm run typecheck` (astro check) and `npm run build`.

Manual smoke (local): `wrangler pages dev` + seed picks → generate → edit → publish → confirm `/weekly` shows the issue and a draft stays hidden until published.

## Edge cases

- **0 eligible picks in range** → `generate` does not create an empty issue; returns a friendly message.
- **Number / slug uniqueness** → `number` defaults to `max+1`, `slug` to `issue-NNN`; on conflict, return an error prompting the editor to change it.
- **Publish with empty title/intro** → 422 validation.
- **A pick can belong to at most one issue** → guaranteed by the single-valued `weekly_issue_id` + the "exclude already-linked" pull.
- **Draft visibility** → public queries filter `published_at IS NOT NULL`; admin sees all.

## Out of scope (YAGNI)

- Cron / scheduled auto-generation.
- Cover image generation or upload (keep the existing big-number cover).
- Any AI scheduling beyond drafting the issue on demand.

## Affected / new files

**New:**
- `app/migrations/0009_weekly_layout.sql`
- `app/src/pages/admin/weekly/index.astro`
- `app/src/pages/admin/weekly/[id].astro`
- `app/src/pages/api/admin/weekly/generate.ts`
- `app/src/pages/api/admin/weekly/[id]/save.ts`
- `app/src/pages/api/admin/weekly/[id]/publish.ts`
- `app/src/pages/api/admin/weekly/[id]/unpublish.ts`
- `app/src/pages/api/admin/weekly/[id]/regenerate.ts`
- `app/src/pages/api/admin/weekly/[id]/delete.ts`
- `app/src/lib/weekly.ts` (pure helpers: `lastWeekRange`, `reconcileLayout`, `repairWeeklyDraft`, layout types)
- `app/scripts/weekly-range.test.ts`, `weekly-reconcile.test.ts`, `weekly-repair.test.ts`

**Modified:**
- `app/src/db/schema.ts` (add `layoutJson`)
- `app/src/lib/llm.ts` (add `callLlmWeekly` + schema + prompt)
- `app/src/lib/queries.ts` (draft filter on 3 queries; `section_count` from layout; weekly admin queries)
- `app/src/lib/cache.ts` (add `bustForWeekly`)
- `app/src/pages/weekly/[number].astro` (render from `layout_json`)
- `app/src/layouts/Admin.astro` (nav link)
