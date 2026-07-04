# Album Picks live outside the daily/weekly streams, gated behind album publication

An Album's Picks are real published Picks (own `/a/<slug>` reader page) but they
are **excluded from the daily stream, the homepage, and the daily RSS**, and are
publicly visible only once their Album's status is `published`.

## Why

The motivating case is importing a finite historical archive (e.g. all 219 Paul
Graham essays). Pouring 219 old articles into "今日精选" would bury the actual
daily editorial. An Album is a destination in its own right, not a day's picks.

## Consequences

- **Implementation choice:** `picks.daily_date` stays `NOT NULL` (rebuilding the
  core `picks` table to make it nullable was judged riskier than the gain).
  Album Picks are excluded from the stream by an **`album_id IS NULL`** filter on
  every stream read, not by a null date. They carry a `daily_date` but get **no
  daily position** (`position_in_day = 0`, not the next slot), so they never
  consume or reshuffle a day's ordering. Ordering within the album is
  `position_in_album` (default = feed/import order, editor-reorderable).
- Public queries that drive `/`, `/daily`, and the daily RSS **exclude album
  Picks** via `album_id IS NULL` — including the daily RSS route's own inline
  query. The daily auto-publish cron likewise skips `album:*` submissions.
- The `/a/<slug>` reader page must gate an album Pick behind
  `album.status = 'published'` — a Pick in a draft Album is not publicly
  reachable. A normal (non-album) Pick renders as before.
- This is the main cross-cutting change: it touches the picks schema, the
  publish path, and every public read query + cache-busting rule.
