# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first — it holds the working conventions (think before coding,
surgical changes) and the Glean-specific "never do without asking" list. This
file covers the architecture and commands those rules operate on.

## Where things live

- `app/` — the only deployable code; do everything here. (`cd app` before any command below.)
- `prototype/` — original static HTML, read-only design reference. Don't edit to "fix" the app.
- `docs/` — long-form design/planning docs.
- Detailed setup (creating D1/KV/R2/Queue bindings, Cloudflare Access, secrets) lives in `app/README.md`. Don't duplicate it; follow it.

## Commands (all from `app/`)

```sh
pnpm dev                  # Astro dev server → http://localhost:4321
pnpm worker:dev           # ingest-consumer worker (separate terminal)
pnpm llm:dev              # llm-consumer worker (third terminal, optional)
pnpm typecheck            # astro check — run before pushing
pnpm db:migrate:local     # apply D1 migrations to local Miniflare
pnpm seed:local           # load tag taxonomy (no demo content)
```

Dev uses `platformProxy` — D1/KV/R2/Queues all run on local Miniflare, no cloud
calls. To reach `/admin` locally, send header `x-glean-admin-dev: 1` (only works
when `import.meta.env.DEV`).

### Tests

Tests are standalone `node:assert` scripts in `app/scripts/*.test.ts`, run with
`tsx`. There is **no** `pnpm test` script and **no** test CI (CI only runs
gitleaks). Run them by hand:

```sh
pnpm exec tsx scripts/tags.test.ts          # one file
for f in scripts/*.test.ts; do pnpm exec tsx "$f" || break; done   # all
```

A test that prints its "passed" line and exits 0 passed; a thrown assertion exits non-zero.

### Deploy — three independent surfaces

Deploy only the surface your change touches:

```sh
pnpm build && pnpm wrangler pages deploy ./dist                    # Pages: src/pages, components, layouts, most of src/lib
pnpm wrangler deploy -c workers/ingest-consumer/wrangler.toml      # extract stage: extract*.ts, ingest.ts (processExtract)
pnpm wrangler deploy -c workers/llm-consumer/wrangler.toml         # LLM stage: llm.ts, ingest.ts (processLlm/runSectionsPhase)
```

`src/lib/ingest.ts` is imported by **both** workers — if you touch it, deploy both.

Gotchas: `pnpm deploy` is intercepted by pnpm 9 as a builtin (use `pnpm run deploy`
or call wrangler directly). Always `pnpm exec wrangler …`, never bare `wrangler`.
`wrangler tail` is flaky — to check a submission, query D1 instead:
`pnpm wrangler d1 execute glean --remote --command "SELECT id, status, reject_reason FROM submissions WHERE id='<ULID>'"`.

## Architecture

### The editorial pipeline (the heart of the app)

A link travels through a two-stage queue pipeline into a human review queue,
then a human publishes it. The submission's `status` column is the state machine
(`app/src/db/schema.ts`, `SUBMISSION_STATUSES`):

```
submit → pending → [ingest-consumer: extract URL → R2]
       → analyzing → [llm-consumer: phase-1 LLM, card fields]
       → composing → [llm-consumer: phase-2 LLM, bilingual body sections]
       → ready      → editor reviews in /admin/[id], edits inline
       → published (copied into `picks`) | rejected (human) | failed (AI, retriable)
```

- **`glean-ingest` queue** → `ingest-consumer` worker → `processExtract()`: fetches the URL, extracts body (Readability/linkedom, with Jina Reader, GitHub, and fxtwitter/X fallbacks — see `extract*.ts`), stores raw body in R2, enqueues to `glean-llm`.
- **`glean-llm` queue** → `llm-consumer` worker → `processLlm()` then `runSectionsPhase()`: calls DeepSeek/OpenAI, writes `ai_*` fields onto the submission row.
- Queues run with `max_retries=0` — any stage error calls `markFailed()` and acks. The human-driven "re-run" in admin is the retry, not the queue. Stalled rows are swept by the reapers in `ingest.ts` (`reapStalled*`).

### Two tables, one copy step

- **`submissions`** — the review queue. All AI output lands here in `ai_*` columns; nothing here is public.
- **`picks`** — what readers see (`/`, `/daily/<date>`, `/weekly/<n>`, `/a/<slug>`, RSS).
- Publishing (`src/lib/publish.ts`) copies an approved submission's fields into a new `picks` row. The two schemas are deliberately separate — don't conflate "AI draft" fields with "published" fields.
- The **analysis JSON schema** (the `ai_*` shape produced by `llm.ts`) flows through the admin UI, publish step, RSS, and pages. Adding/changing a field is a cross-cutting change with a bilingual translation cost — treat it as a spec change, not a code tweak (see AGENTS.md).

### i18n + routing model (load-bearing, easy to break)

Language is **URL-driven**, not cookie-driven: `/en/*` is English, everything
else is Chinese. `src/middleware.ts` is the router:

1. **Trailing-slash canonicalization.** The site's canonical form is **no trailing slash**. `trailingSlash: "ignore"` lets `/about/` match a route so middleware can 301 it to `/about`. For this to fire on exact-match SSR pages, the trailing-slash variant must be listed in `astro.config.mjs` → `routes.extend.include` (Cloudflare ignores `_redirects` when a `_worker.js` exists).
2. **English rewrite.** `/en/about` is internally rewritten to the `/about` route template (middleware does not re-run on rewrite; `locals.lang = "en"` carries through).

**Consequence:** any page reachable at `/en/*` must be SSR (`export const prerender = false`). A prerendered page can't be rendered by the worker on demand, so its `/en/*` variant 500s — and Cloudflare serves it as a static `name/index.html` directory, which 308-redirects the canonical no-slash URL *backwards*. The top-level public pages (`index`, `about`, `standards`, `design-system`) are all SSR for this reason.

### Auth (admin gate)

`/admin*` and `/api/admin*` are gated by **two** layers, both required:
Cloudflare Access (configured in Zero Trust) **and** an `ADMIN_EMAILS` allowlist
enforced inside `middleware.ts`. The middleware refuses every admin request when
`ADMIN_EMAILS` is empty, even behind Access. Re-read `app/SECURITY.md` before
touching the middleware auth block.

### Caching

Public routes set explicit `Cache-Control` (table in `app/README.md`). On
publish/reject, `bustForPick()` in `src/lib/cache.ts` invalidates the affected
routes. If you add a page that shows published picks, wire it into cache busting.

## Things to never change without asking (from AGENTS.md)

- The LLM prompts in `src/lib/llm.ts` — that's the editorial voice, not a code concern.
- The analysis JSON schema — every field flows through admin UI, RSS, and pages.
- The auth middleware in `src/middleware.ts` — the `ADMIN_EMAILS` gate is load-bearing.
