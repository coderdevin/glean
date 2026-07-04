# Albums are a first-class entity, separate from Weekly Issues

Albums (专辑) are persistent, theme/source-based collections of Picks. We store
them in a **new `albums` table** with a single-FK membership (`picks.album_id` +
`picks.position_in_album`), rather than extending `weekly_issues` or introducing
a generalized `collections` table.

## Considered Options

- **New `albums` table (chosen).** Album carries a `feed_url`, a draft/published
  status, and AI-drafted bilingual title/intro/cover — plus a flat ordered
  membership. Clean semantics; nothing bleeds into the weekly path.
- **Extend `weekly_issues` with a `type` discriminator.** Rejected: a weekly's
  `number`, `date_start/date_end`, and `layout_json` sections are meaningless for
  an album, and an album's `feed_url` is meaningless for a weekly. Two semantics
  in one table invite drift and confusing NULLs.
- **Generalize both into a `collections` table.** Rejected as over-engineering:
  it forces a risky refactor of the working weekly feature for no near-term gain.

## Consequences

- Membership is **single** (a Pick is in at most one Album), matching the
  existing `weekly_issue_id` shape rather than a many-to-many join.
- Album title/intro reuse the weekly AI-draft machinery (`llm.ts`), so an
  `album` draft kind joins the existing `weekly`/`weekly-refine` kinds.
