# Submission Status State-Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual-axis (`status` + `aiSectionsStatus`) submission model with a single 7-state machine where `ready` means "AI fully done — publish or reject."

**Architecture:** `submissions.status` becomes the single source of truth: `pending → analyzing → composing → ready → published/rejected`, plus `failed` (AI error, retriable, distinct from editor `rejected`). The sections phase stops being a side-flag and becomes the `composing` state; `ready` is reachable only after sections succeed. A pure helper module owns status labels/colors and the legacy→new mapping used by the data migration.

**Tech Stack:** Astro (SSR, `prerender=false` routes) + Cloudflare Pages/Workers, Drizzle ORM over D1 (SQLite), `tsx` + `node:assert` for unit tests, `wrangler` for build/deploy/migrations. **No git in this repo** — "commit" checkpoints are replaced by `pnpm build` + `tsx` test runs.

**Spec:** `docs/superpowers/specs/2026-05-29-submission-status-machine-design.md`

---

## File Structure

- **Create** `src/lib/submissionStatus.ts` — status enum metadata (bilingual labels + color tone), `isInFlight`/`isReady` predicates, `countValidSections`, and `mapLegacyStatus` (pure, used by the migration + tests).
- **Create** `scripts/submission-status.test.ts` — unit tests for the helper.
- **Create** `migrations/0008_status_machine.sql` — add `failure_stage` column, remap rows to the new single axis.
- **Modify** `src/db/schema.ts` — new `SUBMISSION_STATUSES`, add `failureStage`, deprecate `aiSectionsStatus`.
- **Modify** `src/lib/ingest.ts` — transitions, new `markFailed`, drop auto-unreject + `aiSectionsStatus` writes.
- **Modify** `src/pages/api/admin/[id]/publish.ts` — gate = `status === 'ready'`.
- **Modify** `src/pages/api/admin/[id]/reject.ts` — plain reason (no `editor:` prefix).
- **Modify** `src/pages/api/admin/[id]/regenerate-sections.ts` — mutex on `status='composing'`; set `composing`.
- **Modify** `src/pages/api/admin/[id]/refetch.ts`, `src/pages/api/admin/process.ts` — in-flight status arrays.
- **Modify** `src/pages/admin/[id].astro` — pipelineState = status; remove sections cross-ref + pill suffix.
- **Modify** `src/pages/admin/index.astro` — queue filters + `failed` tab.
- **Modify** `src/components/StatusPill.astro` — labels; drop `sectionsInFlight`.
- **Modify** `src/lib/adminProcessingStatus.ts` — derive stage from status.
- **Modify** `public/styles.css` — `analyzing`/`composing`/`failed` colors; remove `.status-pill__phase`.
- **Modify** `workers/llm-consumer/src/index.ts`, `workers/ingest-consumer/src/index.ts` — `markFailed` + in-flight queries.
- **Delete** `src/lib/sectionsGate.ts`, `scripts/sections-gate.test.ts` (logic absorbed into `submissionStatus.ts`).

---

## Task 1: Status helper module (pure, TDD)

**Files:**
- Create: `src/lib/submissionStatus.ts`
- Test: `scripts/submission-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/submission-status.test.ts`:

```ts
import assert from "node:assert/strict";
import {
  STATUS_META,
  isInFlight,
  isReady,
  countValidSections,
  mapLegacyStatus,
} from "../src/lib/submissionStatus";

// Labels exist for every state, bilingual.
for (const s of ["pending","analyzing","composing","ready","published","rejected","failed"] as const) {
  assert.ok(STATUS_META[s], `meta for ${s}`);
  assert.ok(STATUS_META[s].zh && STATUS_META[s].en, `labels for ${s}`);
}
assert.equal(STATUS_META.analyzing.zh, "AI 解析中");
assert.equal(STATUS_META.composing.zh, "生成正文中");
assert.equal(STATUS_META.ready.en, "Ready");

// Predicates.
assert.equal(isInFlight("analyzing"), true);
assert.equal(isInFlight("composing"), true);
assert.equal(isInFlight("pending"), true);
assert.equal(isInFlight("ready"), false);
assert.equal(isReady("ready"), true);
assert.equal(isReady("composing"), false);

// countValidSections (moved from sectionsGate).
const two = JSON.stringify([{ body_zh: "中", body_en: "en" }, { body_zh: "二", body_en: "two" }]);
assert.equal(countValidSections(two), 2);
assert.equal(countValidSections(JSON.stringify([{ body_zh: "", body_en: " " }])), 0);
assert.equal(countValidSections(null), 0);
assert.equal(countValidSections("not json"), 0);

// mapLegacyStatus: (oldStatus, oldSectionsStatus, rejectReason, sectionsCount) -> new status
assert.deepEqual(mapLegacyStatus("processing", null, null, 0), { status: "analyzing", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", "ok", null, 5), { status: "ready", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", "pending", null, 0), { status: "composing", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", "failed", null, 0), { status: "failed", failureStage: "sections" });
assert.deepEqual(mapLegacyStatus("ready", null, null, 10), { status: "ready", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", null, null, 0), { status: "failed", failureStage: "sections" });
assert.deepEqual(mapLegacyStatus("rejected", null, "llm: boom", 0), { status: "failed", failureStage: "analysis" });
assert.deepEqual(mapLegacyStatus("rejected", null, "extract: 404", 0), { status: "failed", failureStage: "extract" });
assert.deepEqual(mapLegacyStatus("rejected", null, "editor: not good", 0), { status: "rejected", failureStage: null });
assert.deepEqual(mapLegacyStatus("published", "ok", null, 5), { status: "published", failureStage: null });
assert.deepEqual(mapLegacyStatus("pending", null, null, 0), { status: "pending", failureStage: null });

console.log("submission status assertions passed");
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd app && npx tsx scripts/submission-status.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/submissionStatus'`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/submissionStatus.ts`:

```ts
import type { SubmissionStatus } from "~/db/schema";

export type FailureStage = "extract" | "analysis" | "sections";

/** Tone drives the pill color class (status-<tone>) in styles.css. */
export type StatusTone = "muted" | "amber" | "amber2" | "teal" | "green" | "neutral" | "red";

export const STATUS_META: Record<SubmissionStatus, { zh: string; en: string; tone: StatusTone }> = {
  pending:   { zh: "排队中",     en: "Queued",    tone: "muted" },
  analyzing: { zh: "AI 解析中",  en: "Analyzing", tone: "amber" },
  composing: { zh: "生成正文中", en: "Composing", tone: "amber2" },
  ready:     { zh: "待处理",     en: "Ready",     tone: "teal" },
  published: { zh: "已发布",     en: "Published", tone: "green" },
  rejected:  { zh: "已否",       en: "Rejected",  tone: "neutral" },
  failed:    { zh: "处理失败",   en: "Failed",    tone: "red" },
};

const IN_FLIGHT: ReadonlySet<SubmissionStatus> = new Set(["pending", "analyzing", "composing"]);

export function isInFlight(status: SubmissionStatus): boolean {
  return IN_FLIGHT.has(status);
}
export function isReady(status: SubmissionStatus): boolean {
  return status === "ready";
}

/** Sections with text on at least one side. Truncated/all-blank don't count. */
export function countValidSections(sectionsJson: string | null | undefined): number {
  if (!sectionsJson) return 0;
  try {
    const v = JSON.parse(sectionsJson);
    if (!Array.isArray(v)) return 0;
    return v.filter((s) => {
      const zh = typeof s?.body_zh === "string" ? s.body_zh.trim().length : 0;
      const en = typeof s?.body_en === "string" ? s.body_en.trim().length : 0;
      return zh > 0 || en > 0;
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Map a pre-redesign row onto the new single axis. Pure so the SQL migration's
 * intent is unit-tested here even though the migration itself is hand-written
 * SQL. `sectionsCount` = countValidSections(ai_sections_json).
 */
export function mapLegacyStatus(
  oldStatus: string,
  oldSectionsStatus: string | null,
  rejectReason: string | null,
  sectionsCount: number,
): { status: SubmissionStatus; failureStage: FailureStage | null } {
  if (oldStatus === "pending") return { status: "pending", failureStage: null };
  if (oldStatus === "published") return { status: "published", failureStage: null };
  if (oldStatus === "processing") return { status: "analyzing", failureStage: null };

  if (oldStatus === "rejected") {
    if (rejectReason?.startsWith("extract:")) return { status: "failed", failureStage: "extract" };
    if (rejectReason?.startsWith("llm:")) return { status: "failed", failureStage: "analysis" };
    return { status: "rejected", failureStage: null };
  }

  if (oldStatus === "ready") {
    if (oldSectionsStatus === "ok") return { status: "ready", failureStage: null };
    if (oldSectionsStatus === "pending") return { status: "composing", failureStage: null };
    if (oldSectionsStatus === "failed") return { status: "failed", failureStage: "sections" };
    // null: legacy row — trust the data.
    return sectionsCount > 0
      ? { status: "ready", failureStage: null }
      : { status: "failed", failureStage: "sections" };
  }

  // Unknown/legacy value — leave as-is, typed loosely.
  return { status: oldStatus as SubmissionStatus, failureStage: null };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd app && npx tsx scripts/submission-status.test.ts`
Expected: PASS — `submission status assertions passed`.

- [ ] **Step 5: Checkpoint**

Run: `cd app && npx tsc --noEmit -p tsconfig.json 2>&1 | head` (the import resolves; ignore unrelated pre-existing errors). No git commit (no repo).

---

## Task 2: Schema enum + columns

**Files:**
- Modify: `src/db/schema.ts:10-15` (statuses), `:148-156` (sections columns)

- [ ] **Step 1: Replace `SUBMISSION_STATUSES`**

Find:

```ts
export const SUBMISSION_STATUSES = [
  "pending",
  "processing",
  "ready",
  "published",
  "rejected",
] as const;
```

Replace with:

```ts
export const SUBMISSION_STATUSES = [
  "pending",    // submitted, awaiting pipeline
  "analyzing",  // extract + phase-1 LLM (card fields)
  "composing",  // phase-2 LLM (bilingual body sections)
  "ready",      // AI fully done — editor publishes or rejects
  "published",
  "rejected",   // editor decision (human)
  "failed",     // AI failed at some stage (retriable)
] as const;
```

- [ ] **Step 2: Deprecate `aiSectionsStatus`, add `failureStage`**

Find the block:

```ts
    /** Two-pass LLM pipeline state. Analysis runs first and flips status to
     *  'ready'. Sections runs second; this column tracks whether the sections
     *  pass succeeded ('ok'), is still running ('pending'), or failed
     *  ('failed'). Publish requires 'ok'. NULL on rows pre-dating the split. */
    aiSectionsStatus: text("ai_sections_status", {
      enum: ["pending", "ok", "failed"] as const,
    }),
    aiSectionsError: text("ai_sections_error"),
```

Replace with:

```ts
    /** @deprecated Superseded by `status` (analyzing/composing/ready/failed).
     *  No longer read or written. Kept dormant to avoid a destructive D1
     *  column drop; remove in a later migration once confirmed unused. */
    aiSectionsStatus: text("ai_sections_status", {
      enum: ["pending", "ok", "failed"] as const,
    }),
    /** Failure detail text when status='failed' (was the sections error). */
    aiSectionsError: text("ai_sections_error"),
    /** Which pipeline stage failed, when status='failed'. */
    failureStage: text("failure_stage", {
      enum: ["extract", "analysis", "sections"] as const,
    }),
```

- [ ] **Step 3: Checkpoint**

Run: `cd app && pnpm build 2>&1 | tail -5`
Expected: build completes (TS may flag the not-yet-updated call sites — that's fine until Task 3-9; if build hard-fails on enum usage, proceed to the next tasks which fix them, then re-build).

---

## Task 3: `markFailed` helper + worker call sites

**Files:**
- Modify: `src/lib/ingest.ts` (near `markRejected`, ~594-620)
- Modify: `workers/llm-consumer/src/index.ts:165,213`
- Modify: `workers/ingest-consumer/src/index.ts:57,100`

- [ ] **Step 1: Add `markFailed` next to `markRejected` in `ingest.ts`**

After the `markRejected` function (after line ~620), add:

```ts
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
```

Note: requires `EventStatus` to include `"failed"`. Verify `EVENT_STATUSES` in `schema.ts:192` already contains `"failed"` (it does — used by existing `logEvent(... "llm","failed")`). No change needed.

- [ ] **Step 2: Point the LLM worker at `markFailed`**

In `workers/llm-consumer/src/index.ts`, update the import (line ~24-29) to add `markFailed`:

```ts
import {
  processLlm,
  runSectionsPhase,
  markFailed,
  logEvent,
  type IngestEnv,
} from "../../../src/lib/ingest";
```

Replace line ~165:

```ts
        await markRejected(env, id, `llm: ${reason}`).catch((e) =>
          console.error("markRejected failed", e),
        );
```

with:

```ts
        await markFailed(env, id, "analysis", reason).catch((e) =>
          console.error("markFailed failed", e),
        );
```

Replace line ~213:

```ts
          await markRejected(env, targetId, `llm: ${reason}`).catch(() => {});
```

with:

```ts
          await markFailed(env, targetId, "analysis", reason).catch(() => {});
```

Update the in-flight query (line ~188):

```ts
              inArray(submissions.status, ["pending", "analyzing", "composing"]),
```

- [ ] **Step 3: Point the extract worker at `markFailed`**

In `workers/ingest-consumer/src/index.ts`, change the import (line ~24) from `markRejected` to `markFailed`, then replace both call sites (lines ~57 and ~100):

```ts
          await markFailed(env, id, "extract", reason).catch((e) =>
            console.error("markFailed failed", e),
          );
```

and:

```ts
        await markFailed(env, targetId, "extract", reason).catch(() => {});
```

Update its in-flight query (line ~78):

```ts
          .where(inArray(submissions.status, ["pending", "analyzing", "composing"]))
```

- [ ] **Step 4: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5` (errors about `markRejected` now-unused are fine; keep `markRejected` exported — `reject.ts` no longer uses it but no caller should break).

---

## Task 4: Pipeline transitions in `ingest.ts`

**Files:**
- Modify: `src/lib/ingest.ts:141` (extract start), `:233` (idempotency guard), `:306-335` (analysis ok), `:459-493` (sections ok + auto-unreject), `:557-568` (sections fail)

- [ ] **Step 1: Extract start → `analyzing`**

Line ~141, replace:

```ts
    .set({ status: "processing", processingStartedAt: new Date(), processingModel: "extract" })
```

with:

```ts
    .set({ status: "analyzing", processingStartedAt: new Date(), processingModel: "extract" })
```

- [ ] **Step 2: LLM start stays `analyzing`**

Line ~267, replace:

```ts
    .set({ status: "processing", processingStartedAt: new Date(), processingModel })
```

with:

```ts
    .set({ status: "analyzing", processingStartedAt: new Date(), processingModel })
```

- [ ] **Step 3: Analysis ok → `composing`, drop `aiSectionsStatus`**

In the phase-1 success `.set({...})` (line ~308-334), change `status: "ready"` to `status: "composing"` and delete the `aiSectionsStatus: "pending"` line:

```ts
    .set({
      status: "composing",
      aiTitleZh: analysis.output.title_zh,
      // ... unchanged ai* fields ...
      aiSectionsError: null,
      aiTagsJson: JSON.stringify(tagsKept),
      // ... rest unchanged ...
      rejectReason: null,
    })
```

(Remove the line `aiSectionsStatus: "pending",`. Keep `aiSectionsError: null` to clear stale errors.)

- [ ] **Step 4: Sections ok → `ready`, remove auto-unreject**

In `runSectionsPhase` success path (line ~460-467), replace:

```ts
    await db
      .update(submissions)
      .set({
        aiSectionsJson: sectionsJson,
        aiSectionsStatus: "ok",
        aiSectionsError: null,
      })
      .where(eq(submissions.id, args.id));
```

with:

```ts
    await db
      .update(submissions)
      .set({
        aiSectionsJson: sectionsJson,
        status: "ready",
        failureStage: null,
        aiSectionsError: null,
      })
      .where(eq(submissions.id, args.id));
```

Then DELETE the entire auto-unreject block (lines ~468-493, the `const unrejected = await db.update(...).where(and(eq(status,"rejected"), like(rejectReason,"llm:%")))...` and its `if (unrejected.length > 0) { logEvent(...) }`). It is obsolete: regenerate on a `failed` row now flows `composing → ready` directly. Remove the now-unused `like`, `isNotNull` imports if no longer referenced (check with build).

- [ ] **Step 5: Sections fail → `failed`(sections)**

In the `catch` (line ~557-563), replace:

```ts
    await db
      .update(submissions)
      .set({
        aiSectionsStatus: "failed",
        aiSectionsError: msg.slice(0, 500),
      })
      .where(eq(submissions.id, args.id));
```

with:

```ts
    await db
      .update(submissions)
      .set({
        status: "failed",
        failureStage: "sections",
        aiSectionsError: msg.slice(0, 500),
      })
      .where(eq(submissions.id, args.id));
```

- [ ] **Step 6: Idempotency guard** (line ~233) — extend the skip set to include `composing`, since reaching `composing`/`ready`/`published` means analysis already succeeded and a redelivered full-pipeline message must not re-run it. Replace:

```ts
  if (row.status === "ready" || row.status === "published") {
```

with:

```ts
  if (row.status === "composing" || row.status === "ready" || row.status === "published") {
```

(Intentional re-runs via `process.ts`/`refetch.ts` reset status to `pending` first, so this guard never blocks them.)

- [ ] **Step 7: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5`.

---

## Task 5: Publish gate → `status === 'ready'`

**Files:**
- Modify: `src/pages/api/admin/[id]/publish.ts:6-14` (import), `:32-44` (gate)
- Delete: `src/lib/sectionsGate.ts`, `scripts/sections-gate.test.ts`

- [ ] **Step 1: Replace the gate**

Remove the `import { sectionsPublishGate } from "~/lib/sectionsGate";` line. Replace the gate block (lines ~32-44, the `const gate = sectionsPublishGate(...)` through the `if (!gate.canPublish) {...}`) with:

```ts
  // Single source of truth: only a 'ready' row is publishable. Reaching
  // 'ready' already guarantees sections succeeded (see status machine).
  if (sub.status !== "ready") {
    return new Response(
      `cannot publish: status is '${sub.status}', expected 'ready'`,
      { status: 409 },
    );
  }
```

(Keep the earlier early-return for already-published rows.)

- [ ] **Step 2: Stop writing `aiSectionsStatus` on publish if present** — search publish.ts for `aiSectionsStatus`; there is none (it reads `sub.aiSectionsJson` for `sectionsJson`). Leave the `sectionsJson: sub.aiSectionsJson` writes as-is.

- [ ] **Step 3: Delete the retired gate + its test**

Run: `cd app && rm src/lib/sectionsGate.ts scripts/sections-gate.test.ts`

- [ ] **Step 4: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5` (build must not reference sectionsGate anywhere; grep to confirm: `grep -rn sectionsGate src/ scripts/` returns nothing).

---

## Task 6: Admin detail page

**Files:**
- Modify: `src/pages/admin/[id].astro:4` (import), `:181-266` (pipeline + sections derivation), `:286` (StatusPill)

- [ ] **Step 1: Swap imports**

Line ~5, replace `import { sectionsPublishGate } from "~/lib/sectionsGate";` with:

```ts
import { STATUS_META, isInFlight } from "~/lib/submissionStatus";
```

- [ ] **Step 2: Simplify pipeline state to status**

Replace the `pipelineState` derivation (lines ~184-201) so it is driven by `row.status` directly:

```ts
const pipelineState: "running" | "complete" | "failed" | "rejected" | "queued" | "idle" = (() => {
  if (row.status === "failed") return "failed";
  if (row.status === "rejected") return "rejected";
  if (row.status === "ready" || row.status === "published") return "complete";
  if (row.status === "analyzing" || row.status === "composing") return "running";
  if (row.status === "pending") return "queued";
  return "idle";
})();
```

Delete `sectionsPhaseInFlight`, `isAiFailed`, `isEditorRejected` (lines ~184-192) — no longer needed. Update `pipelineFailureReason` (lines ~214-218) to read `row.aiSectionsError` for failures and `row.rejectReason` for editor rejects:

```ts
const pipelineFailureReason: string | null = (() => {
  if (pipelineState === "failed") return (row.aiSectionsError ?? "").trim() || null;
  if (pipelineState === "rejected") return (row.rejectReason ?? "").trim() || null;
  return null;
})();
```

- [ ] **Step 3: Remove the sections cross-reference + pill suffix**

Delete the `sectionsStatus` / `sectionsGate` / `sectionsBlocking` / `sectionsPending` block (lines ~233-251) and replace with:

```ts
// Body sections are guaranteed present once status === 'ready'/'published'.
// While composing, the body drawer shows the "生成中" placeholder.
const sectionsComposing = row.status === "composing";
```

Update any later references: `sectionsPending` → `sectionsComposing`; `sectionsBlocking` → `false` (publish is gated by status now, so the dedicated blocking banner can be dropped or shown only for `failed`). Search the template (lines ~600-700) for `sectionsPending`/`sectionsBlocking` and the `{sectionsPending ? (...)}` blocks and rewire to `sectionsComposing`.

- [ ] **Step 4: StatusPill call**

Line ~286, replace:

```ts
      <StatusPill status={row.status} sectionsInFlight={sectionsPending} />
```

with:

```ts
      <StatusPill status={row.status} />
```

- [ ] **Step 5: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5`.

---

## Task 7: StatusPill + styles

**Files:**
- Modify: `src/components/StatusPill.astro`
- Modify: `public/styles.css:1428-1447` (status colors), remove `.status-pill__phase` (added earlier ~1448-1467)

- [ ] **Step 1: Rewrite StatusPill**

Replace the whole component with:

```astro
---
import type { SubmissionStatus } from "~/db/schema";
import { STATUS_META } from "~/lib/submissionStatus";
interface Props { status: SubmissionStatus; }
const { status } = Astro.props;
const meta = STATUS_META[status];
---
<span class={`status-pill status-${status}`}>
  <span class="lang-zh">{meta.zh}</span><span class="lang-en">{meta.en}</span>
</span>
```

- [ ] **Step 2: Status colors**

In `public/styles.css`, after `.status-pending`/`.status-processing` etc. (lines ~1428-1447): rename/extend so every state has a color. Replace the `.status-processing` rule and add `analyzing`/`composing`/`failed`:

```css
.status-pending   { background: var(--c-surface-cream-strong); color: var(--c-muted); }
.status-analyzing { background: var(--amber-tint); color: var(--c-text-amber-dark); }
.status-composing { background: var(--amber-tint); color: var(--c-text-amber-dark); opacity: 0.9; }
.status-ready     { background: var(--teal-tint); color: var(--c-text-teal-dark); }
.status-published { background: var(--green-tint); color: var(--c-text-green-dark); }
.status-rejected  { background: var(--c-surface-cream-strong); color: var(--c-muted); }
.status-failed    { background: var(--red-tint); color: var(--c-error); }
```

(Keep `.status-processing` as a harmless alias for any un-migrated row, or delete it — no row should carry `processing` post-migration.)

- [ ] **Step 3: Remove the pill suffix CSS**

Delete the `.status-pill__phase`, `@keyframes pillPhasePulse`, and the `prefers-reduced-motion` block added previously (search `status-pill__phase`).

- [ ] **Step 4: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5`; `grep -rn "sectionsInFlight\|status-pill__phase" src/ public/` returns nothing.

---

## Task 8: Admin queue list

**Files:**
- Modify: `src/pages/admin/index.astro:12-19` (FILTERS), `:48` (inFlight), `:82-86` (tabs)

- [ ] **Step 1: Update filter map + in-flight set**

Replace the `FILTERS` map and `FilterKey` (lines ~12-19):

```ts
type FilterKey = "active" | "ready" | "pending" | "published" | "rejected" | "failed" | "all";
const FILTERS: Record<FilterKey, ("pending"|"analyzing"|"composing"|"ready"|"published"|"rejected"|"failed")[]> = {
  active:    ["pending", "analyzing", "composing", "ready"],
  ready:     ["ready"],
  pending:   ["pending", "analyzing", "composing"],
  published: ["published"],
  rejected:  ["rejected"],
  failed:    ["failed"],
  all:       ["pending", "analyzing", "composing", "ready", "published", "rejected", "failed"],
};
```

Update the in-flight filter (line ~48):

```ts
const inFlight = rows.filter((r) => r.status === "pending" || r.status === "analyzing" || r.status === "composing");
```

Add a failed bucket near the others (after line ~50):

```ts
const failed = rows.filter((r) => r.status === "failed");
```

- [ ] **Step 2: Add a `failed` tab**

After the rejected tab (line ~85), add:

```astro
            <a href="/admin?status=failed" class={filterKey === "failed" ? "is-active" : ""}>Failed</a>
```

Also handle the `?status=failed` param parse (line ~26 area) so it resolves to `filterKey="failed"`.

- [ ] **Step 3: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5`.

---

## Task 9: Remaining endpoints + processing-status helper

**Files:**
- Modify: `src/pages/api/admin/[id]/reject.ts:16-28`
- Modify: `src/pages/api/admin/[id]/regenerate-sections.ts:44-67`
- Modify: `src/pages/api/admin/[id]/refetch.ts:17` , `src/pages/api/admin/process.ts:47,61-70`
- Modify: `src/lib/adminProcessingStatus.ts`

- [ ] **Step 1: reject.ts — plain reason**

Replace lines ~16-28 so the reason is stored without the `editor:` prefix:

```ts
  const userReason = form.reject_reason?.trim();
  const reason = userReason || "rejected by editor";

  await db(env.DB).update(submissions).set({
    status: "rejected",
    rejectReason: reason,
    reviewedAt: new Date(),
  }).where(eq(submissions.id, id));
```

(The event log line below stays.)

- [ ] **Step 2: regenerate-sections.ts — gate on new states, set `composing`**

Replace the guard (lines ~48-61):

```ts
  if (isInFlight(sub.status) && sub.status !== "ready") {
    // pending/analyzing/composing — pipeline still running; don't race it.
    return new Response(
      `cannot regenerate sections: pipeline is busy (status=${sub.status})`,
      { status: 409 },
    );
  }
```

Add at top: `import { isInFlight } from "~/lib/submissionStatus";`. Replace the flip-to-pending (lines ~64-67):

```ts
  await db(env.DB)
    .update(submissions)
    .set({ status: "composing", failureStage: null, aiSectionsError: null })
    .where(eq(submissions.id, id));
```

(Note: a `published` row regenerating stays publishable — runSectionsPhase already special-cases `published` to update picks + bust cache, and on success will set status `ready`; that would un-publish it. **Guard:** only flip to `composing` when `sub.status !== "published"`; for published rows keep status `published` and just enqueue. Wrap the update in `if (sub.status !== "published") { ...set composing... }`.)

- [ ] **Step 3: refetch.ts + process.ts — in-flight arrays**

`refetch.ts` line ~17: status reset stays `"pending"` (correct). No enum change needed there.

`process.ts` line ~47 and ~61-70: the "oldest unfinished" query uses `inArray(submissions.status, ["pending", "processing"])` — replace with:

```ts
      .where(inArray(submissions.status, ["pending", "analyzing", "composing"]))
```

The reset block (line ~61-70) sets `status: "pending"` — keep.

- [ ] **Step 4: adminProcessingStatus.ts — derive stage from status**

Change the input to include `status` (already present) and derive the stage from it instead of `rawR2Key`. Replace line ~32:

```ts
  const stage: ProcessingStage = input.status === "composing" ? "llm" : input.rawR2Key ? "llm" : "extract";
```

Add a third card for `composing` so the detail page shows "生成正文中 / Composing the bilingual body" rather than the analysis copy. Minimal version — branch on `input.status === "composing"`:

```ts
  if (input.status === "composing") {
    return {
      stage: "llm",
      title: "Composing sections",
      detail: "Splitting the article into bilingual sections. This page refreshes every 4s.",
      modelLabel,
      elapsedMin,
      elapsedLabel: elapsedMin ? `${elapsedMin}min` : "<1min",
      windowLabel: "typical 2-4min · max 12min",
      progressPct,
      isPastWindow: elapsedMs > LLM_MAX_MS,
      steps: [
        { label: "Draft fields saved", state: "done" },
        { label: "Body sections", state: "active" },
        { label: "Ready for review", state: "pending" },
      ],
    };
  }
```

Place this branch before the existing extract/llm returns.

- [ ] **Step 5: Checkpoint** — `cd app && pnpm build 2>&1 | tail -5`; full grep for stragglers: `grep -rn '"processing"' src/ workers/` should only match harmless spots (none gating). Fix any remaining.

---

## Task 10: Data migration

**Files:**
- Create: `migrations/0008_status_machine.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0008_status_machine.sql`:

```sql
-- Status state-machine redesign: collapse status + ai_sections_status into a
-- single 7-state axis. See docs/superpowers/specs/2026-05-29-...-design.md.
-- Mapping mirrors src/lib/submissionStatus.ts::mapLegacyStatus (unit-tested).

ALTER TABLE submissions ADD COLUMN failure_stage text;  -- extract|analysis|sections

-- processing (extract or phase-1) -> analyzing
UPDATE submissions SET status = 'analyzing' WHERE status = 'processing';

-- ready + sections pending -> composing
UPDATE submissions SET status = 'composing'
  WHERE status = 'ready' AND ai_sections_status = 'pending';

-- ready + sections failed -> failed(sections)
UPDATE submissions SET status = 'failed', failure_stage = 'sections'
  WHERE status = 'ready' AND ai_sections_status = 'failed';

-- ready + NULL flag + NO valid sections json -> failed(sections)
UPDATE submissions SET status = 'failed', failure_stage = 'sections'
  WHERE status = 'ready' AND ai_sections_status IS NULL
    AND NOT (json_valid(ai_sections_json) AND json_array_length(ai_sections_json) > 0);
-- (ready + NULL + has json) stays 'ready' — no statement needed.
-- (ready + 'ok') stays 'ready' — no statement needed.

-- rejected with AI-failure prefix -> failed, move reason into the error field
UPDATE submissions
  SET status = 'failed',
      failure_stage = CASE WHEN reject_reason LIKE 'extract:%' THEN 'extract' ELSE 'analysis' END,
      ai_sections_error = reject_reason,
      reject_reason = NULL
  WHERE status = 'rejected'
    AND (reject_reason LIKE 'llm:%' OR reject_reason LIKE 'extract:%');

-- strip the 'editor:' prefix from genuine editor rejections
UPDATE submissions
  SET reject_reason = ltrim(substr(reject_reason, 8))
  WHERE status = 'rejected' AND reject_reason LIKE 'editor:%';
```

- [ ] **Step 2: Verify mapping parity with the unit test**

Re-read `mapLegacyStatus` (Task 1) and confirm each SQL `UPDATE` matches a tested branch. Specifically: processing→analyzing ✓, ready/pending→composing ✓, ready/failed→failed(sections) ✓, ready/null/no-json→failed(sections) ✓, ready/ok & ready/null/has-json→ready ✓, rejected/llm→failed(analysis) ✓, rejected/extract→failed(extract) ✓, rejected/editor→rejected(stripped) ✓.

- [ ] **Step 3: Dry-run locally**

Run: `cd app && pnpm wrangler d1 migrations apply glean --local` then
`pnpm wrangler d1 execute glean --local --command "SELECT status, count(*) FROM submissions GROUP BY status;"`
Expected: only the 7 new status values appear; no `processing`.

---

## Task 11: Deploy + remote migration

- [ ] **Step 1: Final full build + tests**

Run: `cd app && npx tsx scripts/submission-status.test.ts && pnpm build 2>&1 | tail -5`
Expected: tests pass, build completes. `grep -rn "aiSectionsStatus\|sectionsPublishGate\|sectionsInFlight" src/ workers/` returns only the dormant schema column declaration.

- [ ] **Step 2: Snapshot remote rows (rollback safety)**

Run: `cd app && pnpm wrangler d1 execute glean --remote --json --command "SELECT id, status, ai_sections_status, reject_reason FROM submissions;" > /tmp/glean-status-snapshot.json`

- [ ] **Step 3: Quiesce probe (avoid stranding a mid-pipeline row)**

Run: `pnpm wrangler d1 execute glean --remote --command "SELECT status, ai_sections_status, count(*) n FROM submissions GROUP BY 1,2;"`
Confirm NOTHING is actively mid-pipeline — i.e. no `processing` rows and no `ready`+`ai_sections_status='pending'` rows (a sections job in flight). If any exist, wait for them to finish before migrating, else the old in-flight worker run could strand the remapped row.

- [ ] **Step 4: Apply remote migration FIRST (adds `failure_stage` column + remaps)**

Order matters: the new code writes `failure_stage`, so the column must exist before the new code runs — migrate before deploy to avoid a "no such column" window. Run: `pnpm wrangler d1 migrations apply glean --remote`
Verify: `pnpm wrangler d1 execute glean --remote --command "SELECT status, count(*) FROM submissions GROUP BY status;"` → 7 states, no `processing`.

- [ ] **Step 5: Deploy code — Pages AND both workers (back-to-back)**

`pnpm run deploy` only ships the Pages app. The queue workers import `ingest.ts` and must be redeployed too, or the pipeline keeps writing old statuses. Run all three:
```
cd app && pnpm run deploy 2>&1 | tail -3
pnpm run worker:deploy 2>&1 | tail -3
pnpm run llm:deploy 2>&1 | tail -3
```
(All require user authorization. Avoid loading the admin UI during the brief migrate→deploy window — old Pages code has no label for the new statuses.)

- [ ] **Step 6: Smoke test**

Submit a fresh URL; watch the admin detail page walk `排队中 → AI 解析中 → 生成正文中 → 待处理`. Confirm Publish is rejected (409) until `待处理`, and that a forced failure shows `处理失败` with a stage.
