# Submission status state-machine redesign

**Date:** 2026-05-29
**Status:** Shipped (migration applied to remote D1; Pages + both workers deployed). A post-ship reliability fix followed — see § 7.
**Scope:** Replace the dual-axis submission status model with a single 7-state
machine where `ready` means "AI fully done, awaiting editor decision."

---

## Problem

The admin pipeline tracks submission progress on **two parallel axes**:

- `submissions.status`: `pending → processing → ready → published / rejected`
- `submissions.aiSectionsStatus`: `null / pending / ok / failed`

Phase-1 (analysis) flips `status` to `ready` while phase-2 (sections) is still
running on the second axis. This caused (audited):

- **P1** — `ready` does not mean ready: the review queue (`status='ready'`)
  contains rows whose bilingual body is still generating.
- **P2** — Publish eligibility requires cross-referencing *both* axes; the
  direct cause of the "sections phase missing" publish block and the "READY
  while generating" confusion.
- **P3** — `processing` is overloaded for two stages (extract vs LLM),
  disambiguated by sniffing the `processingModel` string.
- **P4** — `rejected` is overloaded for *editor rejection* vs *AI failure*,
  disambiguated by a `reject_reason` string prefix (`editor:` / `llm:`).
- **P5** — `aiSectionsStatus = NULL` is ambiguous (legacy vs missing); the 0007
  backfill only covered ready/published rows.
- **P6** — Silent dead-end: a `ready` row with `aiSectionsStatus='failed'`
  looks publishable; the editor only learns otherwise on clicking publish.

## Goal

`status` is the single source of truth. The editor's mental model becomes:
**when it says `ready`, just publish or reject.** Everything else is either
in-flight (AI working) or `failed` (needs a retry).

---

## § 1 — States & transitions

Seven states (two-phase in-flight):

| State | Meaning | Set by |
|---|---|---|
| `pending` | submitted, awaiting pipeline | `submit.ts` |
| `analyzing` | extract + phase-1 LLM (title/summary/bullets/tags/score) | `processExtract` start |
| `composing` | phase-2 LLM (bilingual body sections) | after analysis ok |
| `ready` | **AI fully done — publish or reject** | after sections ok |
| `published` | live | `publish.ts` |
| `rejected` | **editor said no** (human decision) | `reject.ts` |
| `failed` | **AI failed** at some stage (retriable) | any phase error |

```
pending ──extract starts──▶ analyzing ──analysis ok──▶ composing ──sections ok──▶ ready
                              │                          │                          │
                              │ extract/analysis fails   │ sections fail            ├─ publish ─▶ published
                              ▼                          ▼                          └─ reject  ─▶ rejected
                            failed ◀────────────────────┘

ready / failed ──editor reject──▶ rejected
failed ──retry (analysis bad)──▶ analyzing
failed ──retry (only sections bad)──▶ composing
published ──regenerate sections──▶ (stays published; rebuilds body + busts cache)
```

Invariants:
- `ready` is reachable **only** after the sections phase succeeds.
- `failed` is distinct from `rejected`. No `reject_reason` prefix sniffing.
- The review queue = `status = 'ready'` and contains only publishable rows.

## § 2 — Schema & data migration

### Schema (`src/db/schema.ts`)
- `SUBMISSION_STATUSES = [pending, analyzing, composing, ready, published, rejected, failed]` (remove `processing`).
- `aiSectionsStatus` no longer gates anything. Keep `aiSectionsJson` (the data).
  Remove `aiSectionsStatus` from all decision paths. **Decision:** leave the
  column dormant (do not drop) to minimize migration risk; mark it deprecated in
  a schema comment and stop reading/writing it.
- Add `failureStage` (`extract | analysis | sections`), nullable — set when
  `status='failed'`.
- **Decision:** keep the existing `aiSectionsError` column name and repurpose it
  as the generic failure-error text (no rename). It is written only when
  `status='failed'`.
- `rejectReason` now holds **only** the editor's rejection note (no prefix).

### Data migration (new SQL migration)
Map existing rows to the new single axis:

| old `status` | old `aiSectionsStatus` / reason | → new `status` | notes |
|---|---|---|---|
| `pending` | — | `pending` | |
| `processing` | — | `analyzing` | processing only ever = extract or phase-1 |
| `ready` | `ok` | `ready` | |
| `ready` | `null` **with** valid sections json | `ready` | legacy rows the 0007 backfill missed |
| `ready` | `pending` | `composing` | sections were mid-flight |
| `ready` | `failed` | `failed` (stage=sections) | |
| `ready` | `null` **no** valid sections | `failed` (stage=sections) | stuck phase-2 |
| `published` | — | `published` | |
| `rejected` | reason `LIKE 'llm:%'` | `failed` | move reason → failure error; this is the *last* use of the prefix sniff |
| `rejected` | else | `rejected` | strip any `editor:` prefix from reason |

"valid sections json" = `countValidSections(aiSectionsJson) > 0` (≥1 section
with non-empty body on either side). `countValidSections` is preserved from the
retired `sectionsGate.ts` for exactly this mapping.

## § 3 — Code touch-points (units)

- **`src/lib/ingest.ts`**
  - `processExtract`: set `analyzing` at start (was `processing`). Extract
    failure → `failed` (stage=extract).
  - `processLlm`: stays `analyzing` during phase 1. Analysis failure → `failed`
    (stage=analysis). Analysis ok → set `composing` (was `ready`), then run
    sections.
  - `runSectionsPhase`: sections ok → `ready`. Sections fail → `failed`
    (stage=sections). Drop all `aiSectionsStatus` writes. Replace the
    `LIKE 'llm:%'` auto-unreject with: regenerate on a `failed` row → re-enters
    `composing` → `ready` on success.
  - Idempotency guard (`status IN (ready, published)`) updated to the terminal
    set that should skip re-running (`ready`, `published`).
- **`src/pages/api/admin/[id]/publish.ts`** — gate collapses to
  `status === 'ready'`. Retire `sectionsPublishGate`.
- **`src/lib/sectionsGate.ts`** + **`scripts/sections-gate.test.ts`** — retire
  the gate; keep `countValidSections` (moved to a small util or the migration
  script) for the data migration only.
- **`src/pages/admin/[id].astro`** — `pipelineState` *is* `status` now; delete
  `sectionsPhaseInFlight` / `sectionsBlocking` / `sectionsStatus` cross-ref.
  Remove the `· sections…` pill hack and the `sectionsInFlight` prop usage.
- **`src/pages/admin/index.astro`** — `ready` filter = truly ready;
  "in flight" = `pending | analyzing | composing`; add a `failed` filter tab.
- **`src/components/StatusPill.astro`** — add `analyzing / composing / failed`
  labels; drop the `sectionsInFlight` prop and `.status-pill__phase` markup.
- **`src/pages/api/admin/[id]/reject.ts`** — editor reject → `rejected`, plain
  reason (no prefix).
- **`src/pages/api/admin/[id]/regenerate-sections.ts`** — retrigger sections →
  `composing`; on done → `ready`. Mutex now keys off `status='composing'`.
- **`src/pages/api/admin/[id]/refetch.ts`**, **`process.ts`** — re-run →
  `pending`.
- **`src/lib/adminProcessingStatus.ts`** — adapt the window / progress / stage
  derivation to the new state names (drop `processingModel` sniffing).
- **`public/styles.css`** — status colors for `analyzing` / `composing` /
  `failed`; remove `.status-pill__phase` + `pillPhasePulse`.

## § 4 — UI labels & color

`StatusPill` switches to real bilingual labels (was English in both languages):

| State | 中文 | EN | Color intent |
|---|---|---|---|
| pending | 排队中 | Queued | grey / muted |
| analyzing | AI 解析中 | Analyzing | amber |
| composing | 生成正文中 | Composing | amber (2nd shade) |
| ready | 待处理 | Ready | teal (the "go" state) |
| published | 已发布 | Published | green |
| rejected | 已否 | Rejected | neutral |
| failed | 处理失败 | Failed | red |

## § 5 — Testing

- Unit (tsx + node:assert, repo convention): a pure `nextStatus` /
  transition-mapper helper covering each transition and each migration mapping
  row in § 2.
- Keep `countValidSections` tests for the migration mapping.
- Manual: verify a freshly-submitted row walks
  `pending → analyzing → composing → ready` in the admin UI and that publish is
  blocked until `ready`; verify a forced failure lands in `failed` with a stage.

## § 6 — Risks & rollout

- **Data migration is one-way.** Snapshot/export `submissions(status,
  ai_sections_status, reject_reason)` before applying to remote D1.
- The `processing` enum value disappears; ensure no in-flight row is mid-extract
  at migration time, or it maps cleanly to `analyzing` (idempotent re-run safe).
- Deploy order: ship code that understands the new enum, then apply the data
  migration, to avoid the worker writing an unknown enum. (Adding the new enum
  values is additive; removing `processing` is the only breaking step.)

## Out of scope (at original design time)
- Changing the queue/worker topology — **superseded by § 7**, which decoupled
  sections into its own queue invocation.
- Reworking the events timeline schema.
- Public site / picks table (`draft|published`) — unaffected.

---

## § 7 — Post-ship reliability fix: stranded in-flight runs

**Symptom (observed in prod):** a submission sat in `composing` showing
"running… 70min" in admin, with no completion and no error — and re-running it
kept "failing." The 15-minute Cloudflare ceiling makes a genuine 70-min run
impossible, so the run had clearly died while the UI counted from the last
`started` event.

**Root cause (two compounding bugs):**

1. **Inline analysis + sections exceeded the worker wall-time ceiling.** The
   full pipeline ran *both* phases in one `processLlm` invocation. A queue
   consumer is killed at a **15-min wall-time ceiling** (`visibility_timeout_ms
   = 900000`); the sections stream budget alone was **840s (14min)**. On a slow
   sections run, analysis + sections crossed 15min and Cloudflare **evicted the
   worker** — an external kill that bypasses every `try/catch`, so no `failed`
   status / error was ever written. The row stranded in `composing`.

2. **The reaper measured staleness from a stale clock.** The cron reaper flags
   in-flight rows older than `STALL_WINDOW_MS` using `processing_started_at`,
   but `regenerate-sections` (and the decoupled sections invocation) never reset
   that column. A regenerated row carried its original analysis timestamp (often
   hours old), so the reaper killed the *fresh* run within ~5 min — making every
   regenerate "fail" immediately.

Neither was a DeepSeek problem. Verified by a clean full-budget run after the
fix: **22 sections produced in ~362s**, no API error, no parse failure, no R2
dump — the API was always healthy; the runs were simply being *killed* before
finishing.

**Fix:**

- **Decouple sections into its own queue invocation.** `processLlm` now stops
  after analysis (status → `composing`) and returns `needsSections: true`; the
  llm worker enqueues a separate `phase=sections` message so sections gets a
  fresh 15-min budget. Reuses the existing `phase=sections` machinery
  (`runSectionsOnly`). Dev runs sections inline (no ceiling / no queue poller).
- **Reset the stall clock at the start of any sections run** —
  `runSectionsPhase` stamps `processing_started_at = now`, and
  `regenerate-sections` does too when flipping to `composing` (covers queue
  latency). The reaper's window is now measured from the actual phase start.
- **Cron reaper.** `reapStalledSubmissions` + a `scheduled()` handler on the llm
  worker (`crons = ["*/5 * * * *"]`) flips `analyzing`/`composing` rows older
  than `STALL_WINDOW_MS` (20min) to `failed` with an explanatory error, so a
  platform-evicted run surfaces as `处理失败` within ~5min instead of a perpetual
  "running…".
- **Timeout margin + non-blocking cancel.** Sections stream timeout 840s →
  **780s** (leaves ~2min for cleanup before the ceiling); `reader.cancel()` is
  fire-and-forget so a wedged SSE stream can't swallow the timeout error
  (`src/lib/llm.ts`).

**Files:** `src/lib/ingest.ts` (decouple, `markFailed` already present,
`reapStalledSubmissions`, `isStalledInFlight`, clock reset in `runSectionsPhase`),
`src/lib/llm.ts` (timeout + cancel), `workers/llm-consumer/src/index.ts`
(enqueue sections after analysis, `scheduled` handler),
`workers/llm-consumer/wrangler.toml` (`[triggers] crons`),
`src/pages/api/admin/[id]/regenerate-sections.ts` (clock reset),
`scripts/reaper.test.ts` (pure `isStalledInFlight` test).

**Note:** deploy must redeploy **both workers** (`worker:deploy` + `llm:deploy`),
not just Pages — `pnpm run deploy` only ships the Pages app, but the workers
bundle `ingest.ts`.
