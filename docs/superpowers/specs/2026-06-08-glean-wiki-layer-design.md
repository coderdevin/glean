# Glean Wiki Layer — Design

**Date:** 2026-06-08 · **Status:** approved, building in one pass

## Context

Glean already mirrors Karpathy's LLM-Wiki (raw sources → LLM-maintained pages → human editor).
This adds the missing top layer: published **picks become the raw data**, and admin synthesizes
them into a **public wiki index page** — an LLM-written map of the corpus (themes/topics with
bilingual blurbs + cross-links to picks). Admin rebuilds it on demand and lints it. Normal users
get a CLI limited to **query + submit** (plus status/read).

## Decisions (resolved)

- **Wiki = index page only** (one generated map, no per-topic pages yet).
- **Public** wiki: `/wiki` + `/en/wiki`; CLI `query` searches picks + wiki topics.
- **Manual rebuild**, and **rebuild publishes live** (no draft/review state).
- **CLI**: keep `query`, `submit` (renamed from `ingest`), `status`, `read`; **remove `ask` + `lint`**.
- **Lint moves to admin** (server-side), gains wiki-health checks.

## Architecture

```
submit ─pipeline─▶ published picks ──(raw data)
                         │
   admin /admin/wiki ──[Rebuild]──▶ enqueue glean-llm `kind=wiki`
                         │            └▶ runWikiPhase(): LLM clusters picks → topics+intro
                         │                 → writes wiki_index row (live) → done
                         │            [Lint] corpus + wiki-health findings
                         ▼ live
        public /wiki + /en/wiki  ·  GET /api/wiki
                         ▲
   CLI:  query (picks + wiki topics) · submit · status · read
```

## Data — `wiki_index` table (migration 0017), modeled on `weekly_issues`

`id` (ULID) · `intro_zh` · `intro_en` · `topics_json` (`[{title_zh,title_en,blurb_zh,blurb_en,pick_slugs[]}]`)
· `model` · `picks_count` (snapshot) · `generated_at` · `created_at`. Newest row = live. No status column
(rebuild publishes live).

## Generation (mirrors `kind=weekly`)

- `POST /api/admin/wiki/rebuild` enqueues `glean-llm` with `kind=wiki` → worker routes to
  **`runWikiPhase(env)`** in new `src/lib/wiki.ts`.
- `runWikiPhase`: load all published picks (slug/title/summary/tags) → **new, separate wiki prompt**
  (additive; does NOT touch editorial prompts) → LLM returns topics+intro JSON → validate slugs →
  insert `wiki_index` row → logEvent.
- Reuses the worker's existing LLM client/config. **Deploys: llm-consumer + Pages.**

## Surfaces

- **Public:** `/wiki` + `/en/wiki` (SSR, bilingual, added to `astro.config.mjs` `routes.extend.include`);
  `GET /api/wiki` (JSON). Both CDN-cached with short `s-maxage` (same posture as `/api/picks`, no KV) —
  a rebuild is reflected publicly within the cache window; admin sees it instantly (admin pages are no-store).
- **Admin:** `Wiki` nav entry in `src/layouts/Admin.astro`; `/admin/wiki` = current index preview +
  `generated_at` + **Rebuild** button + **Lint** panel.

## Lint → admin (server-side `src/lib/lint.ts`)

Server-side checks over D1, surfaced on `/admin/wiki`:
- corpus: missing zh/en (title/summary/sections), duplicate host+title, orphan/unknown tags
- wiki: topics with no picks, picks referenced by no topic (coverage gaps), dead `pick_slug` links,
  stale (picks published after `generated_at`).
CLI `lint` is removed.

## CLI rescope

- Rename command `ingest` → `submit` (frees "ingest" for the admin meaning).
- Remove `ask`, `lint` (+ their lib modules and tests).
- `query` gains wiki awareness: bare `glean query` prints the wiki map; with terms, matching wiki
  topics print above matching picks. New `GET /api/wiki` backs it.

## Verification

- Migration applies; `runWikiPhase` produces a valid row from seeded/local picks.
- `/api/wiki` + `/wiki` render; `/en/wiki` works (SSR i18n).
- `/admin/wiki` rebuild enqueues; lint surfaces findings.
- CLI: `submit`, `status`, `query` (with wiki topics), `read`; `ask`/`lint` gone; tests + both typechecks pass.
- Deploys: Pages + llm-consumer.
```
