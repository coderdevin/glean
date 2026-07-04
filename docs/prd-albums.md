# PRD — Albums (专辑)

> Status: ready-for-agent · Scope decided in a grilling + domain-modeling
> session. See `CONTEXT.md` (Album / Feed / Album import) and
> `docs/adr/0001..0003`. Local-only draft (not published to a tracker).

## Problem Statement

The editor wants to bring an entire external body of writing into Glean as one
coherent, browsable unit — e.g. *all* of Paul Graham's essays from
`http://www.aaronsw.com/2002/feeds/pgessays.rss` (219 articles). Today the only
way in is the one-link-at-a-time review pipeline, and everything that publishes
lands in the **daily stream**. There is no way to (a) pull a whole source in at
once, (b) run each article through Glean's existing treatment (要点提取 +
双语段落翻译), or (c) present the result as a standalone collection instead of
drowning "今日精选" under hundreds of old articles. The editor also wants more
than one such collection.

## Solution

Introduce two related concepts, kept distinct:

- **Album (专辑)** — a curated, persistent, ordered collection of published
  **Picks** with its own bilingual title, intro, and cover. An Album has a
  draft/published lifecycle. Its Picks live **outside** the daily/weekly streams
  and become publicly visible only once the Album is published.
- **Feed (订阅源)** — an RSS/Atom URL configured on an Album. An **Album import**
  reads the Feed and pushes every fresh article through the normal
  extract→LLM pipeline, **ungated** (bypassing the discovery score gates), to
  auto-publish into that Album.

The editor creates an Album, sets its Feed URL, clicks **Import**, watches the
articles process and auto-publish into the Album, optionally edits any Pick or
reorders them, generates/edits the AI-drafted Album title & intro, and clicks
**Publish** to make the Album live at `/album/<slug>`. Multiple Albums are
supported; readers browse them at `/album` and read within one at
`/album/<slug>`.

## User Stories

### Editor — album lifecycle

1. As an editor, I want to create a new Album with a slug, so that I have a
   container to import a source into.
2. As an editor, I want to set an Album's Feed URL, so that I can point it at a
   source like the PG essays RSS.
3. As an editor, I want to trigger a one-shot **Import** of the Album's Feed, so
   that every article in it enters the pipeline without me submitting links one
   by one.
4. As an editor, I want the import to **bypass the discovery score gate**, so
   that I get the whole source I already decided is worth keeping — not a
   score-filtered subset.
5. As an editor, I want each imported article to run through the same
   extract→LLM treatment as normal links (要点 + 双语分节), so that Album Picks
   match the quality of the rest of the site.
6. As an editor, I want processed articles to **auto-publish into the Album**
   (not into the daily stream), so that I don't have to hand-review 219 items.
7. As an editor, I want to see import progress for an Album (queued / processed /
   published / failed counts), so that I know when it's done and what went wrong.
8. As an editor, I want articles that fail extraction or LLM to remain in the
   existing `failed` submissions queue with a reason, so that failures are
   visible and retriable, not silently dropped.
9. As an editor, I want to re-run (retry) a failed Album article, so that a
   transient failure doesn't permanently exclude it from the Album.
10. As an editor, I want to edit any Album Pick's fields after auto-publish
    (title, summary, bullets, sections, editor note), so that I can fix AI output
    on important pieces.
11. As an editor, I want the Album's Picks ordered by feed/import order by
    default, so that a reasonable order exists without manual work.
12. As an editor, I want to manually reorder Picks within an Album, so that I can
    override the default order where it matters.
13. As an editor, I want to generate an AI draft of the Album's bilingual title
    and intro from its member articles (reusing the weekly draft machinery), so
    that I get a strong starting point.
14. As an editor, I want to edit the AI-drafted title and intro, so that the
    final copy is mine.
15. As an editor, I want to upload/set an Album cover image, so that the Album
    reads as a designed unit.
16. As an editor, I want an Album to stay a **draft** (not public) until I
    explicitly publish it, so that readers never see a half-imported collection.
17. As an editor, I want to publish an Album, so that it and its Picks become
    publicly visible.
18. As an editor, I want to unpublish or keep editing a published Album, so that
    I can correct it later.
19. As an editor, I want to re-import a Feed later to pull in newly added
    articles, so that a still-active source can be topped up (by clicking Import
    again).

### Editor — dedup & adoption

20. As an editor, I want an import to **skip** URLs already processed (existing
    Pick or in-flight Submission), so that I don't pay to reprocess or create
    duplicate Picks.
21. As an editor, I want an existing Pick that belongs to **no** Album to be
    **adopted** into the Album on import, so that a piece I published earlier
    joins its collection automatically.
22. As an editor, I want a Pick that already belongs to **another** Album to be
    skipped (not moved), so that single-album membership is never silently
    violated.

### Reader

23. As a reader, I want an Albums index at `/album`, so that I can see all
    published Albums (cover, title, article count).
24. As a reader, I want an Album's title/intro/cover shown at `/album/<slug>`, so
    that I understand what the collection is.
25. As a reader, I want the Album's Picks listed in order at `/album/<slug>`, so
    that I can read the collection front to back.
26. As a reader, I want to open any Album Pick's full article page (`/a/<slug>`)
    with 双语段落, so that I get the same reading experience as other Picks.
27. As a reader, I want Album Picks to **not** clutter the homepage / `/daily` /
    daily RSS, so that "今日精选" stays about today's editorial.
28. As a reader in English (`/en/album`, `/en/album/<slug>`), I want the Album
    pages to render, so that the collection is bilingual like the rest of the
    site.
29. As a reader, I want Albums reachable from the site's main navigation
    alongside 每日/每周, so that I can discover collections.
30. As a reader, I want a draft (unpublished) Album and its Picks to be
    unreachable, so that I never land on a half-finished collection or a
    404-worthy article.

### System / non-functional

31. As the system, I want Album-import Submissions tagged with an `album:<slug>`
    origin, so that `processLlm`'s `auto:*` gate-2 screening never applies to
    them.
32. As the system, I want a Pick to belong to at most one Album, so that
    membership stays a single foreign key, not a many-to-many.
33. As the system, I want `/album*` responses to carry explicit cache headers and
    to be invalidated when an Album publishes, changes, or its membership
    changes, so that reader caching stays correct.

## Implementation Decisions

**Data model (see ADR-0001, ADR-0002)**

- New **`albums`** table: `id`, `slug` (unique), `title_zh`/`title_en`,
  `intro_zh`/`intro_en`, `cover_image_key`, `feed_url`, `status` (`draft` |
  `published`), the weekly-style async draft fields (`draft_status`,
  `draft_error`, `draft_started_at`), `published_at`, `created_at`.
- **`picks`** gains `album_id` (nullable FK) and `position_in_album` (int).
- **`picks.daily_date`** becomes **nullable** — Album Picks have no daily
  placement. This is the single largest cross-cutting change; every existing
  read that assumes a non-null `daily_date` must be audited.
- Single-album membership: `album_id` mirrors the existing `weekly_issue_id`
  shape (one FK), not a join table.

**Ingest / import (see ADR-0003)**

- Reuse the existing **`parseFeed`** to turn Feed XML into candidates.
- Album-import Submissions carry `source = "album:<slug>"`. `processLlm` treats a
  non-`auto:*` source as full-run (like `manual`), so no gate-2 screening.
- Import is **one-shot on demand** (admin action), not a cron. Re-import = click
  again.
- Dedup + adoption is a pure planning step (the `planAlbumImport` seam below):
  partition candidates into **enqueue** (fresh URL), **adopt** (existing Pick
  with no album → set its `album_id`/`position_in_album`), and **skip** (in
  flight, or Pick already in another album). Reuses normalized-URL keys.
- Enqueue all fresh candidates into the existing `glean-ingest` queue; rely on
  Cloudflare Queue concurrency for throttling (no bespoke rate limiter).

**Publish (auto into album)**

- Reuse **`publishFieldsFromAi`** for the AI→editorial-field mapping. An
  album-aware publish variant writes the Pick with `album_id` set,
  `position_in_album` assigned (default = import order), and `daily_date = NULL`.
  It must NOT assign a daily position.
- Failures behave exactly as today: a Submission missing AI title/summary or that
  errored stays in the `failed`/unpublished state, visible in `/admin`.

**Album metadata (AI draft)**

- Reuse the weekly async draft state machine in `llm.ts`; add an `album` draft
  kind that generates bilingual `title`/`intro` from the Album's member Picks.
  Editor can edit the result. (No layout sections — an Album is a flat ordered
  list, unlike a weekly's `layout_json`.)

**Reader surface**

- New routes `/album` (index) and `/album/<slug>` (detail). Both **SSR**
  (`prerender = false`) and their `/album/` trailing-slash variants listed in
  `astro.config.mjs` `routes.extend.include`, per the i18n/routing model — so
  `/en/album` and `/en/album/<slug>` render.
- Add an Albums entry to the main navigation (label 专辑 / Albums).

**Visibility predicate**

- Public stream queries (`/`, `/daily`, daily RSS) filter to `album_id IS NULL`.
- `/a/<slug>` renders an Album Pick only when its Album's `status = 'published'`;
  a non-album Pick renders as before.

**Deploy surface** (per CLAUDE.md): touching `ingest.ts` (album publish variant)
means redeploying **all three workers** (ingest, llm, discovery) plus Pages. The
llm draft kind is in `llm.ts` (llm-consumer). Migrations run against D1.

## Testing Decisions

**What makes a good test here:** exercise external behavior of pure functions
only — string/JSON/data in, decision data out — with dependencies injected (URL
normalizer, known-URL/known-Pick state). No D1, no network, no queue. Follow the
existing `node:assert` + `tsx` script convention in `app/scripts/*.test.ts`; a
test that prints its "passed" line and exits 0 passed.

**Modules to test (seams):**

- **`planAlbumImport` (new, one new seam).** The album analog of
  `partitionUnseen`. Given candidates, a description of each known URL's
  disposition (in-flight submission / Pick with no album / Pick in another
  album), and an injected `norm`, it returns the enqueue / adopt / skip
  partition and default `position_in_album` values. Prior art:
  `scripts/discovery-dedup.test.ts` (`partitionUnseen`). Cases: intra-batch
  dup collapse, skip in-flight, adopt album-less Pick, skip Pick in another
  album, position ordering follows input order.
- **`parseFeed` (existing seam).** Already covered by
  `scripts/discovery-parsers.test.ts`. Add a case for a title+link-only feed
  (no `<description>`/`<pubDate>`), matching the PG feed shape, to lock in that
  Album import parses it.
- **`publishFieldsFromAi` (existing seam).** Covered by
  `scripts/publish-fields.test.ts`. No album-specific field logic is added here
  (album_id/daily_date are set by the writer, not the mapper), so existing
  coverage stands; note it explicitly.
- **Visibility predicate (small new pure helper).** Unit-test the rule table:
  non-album Pick → visible; album Pick + draft album → not visible; album Pick +
  published album → visible; stream filter excludes any Pick with an `album_id`.

Integration glue (queue enqueue, DB writes, cache-busting, the SSR pages) is not
separately unit-tested — it composes the above tested cores, consistent with how
discovery/weekly are covered in this repo.

## Out of Scope

- **Per-album RSS feed** (`/rss/album/<slug>`).
- **Cron / incremental follow** of an Album's Feed — MVP is one-shot manual
  import; new articles require clicking Import again.
- **Automatic cover-image generation** — cover is a manual upload for now.
- **Many-to-many membership** — a Pick belongs to at most one Album.
- **Sorting by original publication date** — the PG feed has no `<pubDate>`, so
  ordering is feed/import order + manual reorder only.
- **Album email digests** and any subscriber delivery for Albums.
- Migrating existing Weekly Issues into the Albums model — the two coexist.

## Further Notes

- **The motivating Feed:** `http://www.aaronsw.com/2002/feeds/pgessays.rss` is
  HTTP-only, has **219 `<item>`s**, and each item carries only `<title>` +
  `<link>` (to `paulgraham.com/*.html`) — **no body, no `<pubDate>`**. So (a)
  each article's body must be fetched from its origin by the existing extract
  stage, and (b) feed order is the only cheap ordering signal (validating the
  ordering decision).
- **Cost/time:** 219 articles × (1 extract + 2 LLM phases) ≈ 438 LLM calls per
  full import. Recommend importing a small batch (3–5) first to validate
  extraction quality on PG's older `<font>`-heavy HTML before running all 219.
- **Extraction risk:** paulgraham.com essays are simple but old HTML; if
  Readability underperforms, the existing Jina Reader fallback in the extract
  stage applies — no album-specific extractor is planned.
- Language of these Picks will be `en` (source), so the bilingual pipeline
  generates the 中文 sections — matching the "翻译段落" requirement.
