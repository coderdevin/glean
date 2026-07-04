-- 0020_albums.sql
-- Albums (专辑): persistent, source/theme-based collections of picks.
-- Additive only — no rebuild of the core `picks` table. Album picks keep a
-- daily_date like any pick but are excluded from the daily/home/RSS streams by
-- an `album_id IS NULL` filter in queries (see docs/adr/0002), and gated behind
-- album publication at /a/<slug>.

CREATE TABLE albums (
  id               text    PRIMARY KEY,
  slug             text    NOT NULL UNIQUE,
  title_zh         text    NOT NULL,
  title_en         text    NOT NULL,
  intro_zh         text,
  intro_en         text,
  cover_image_key  text,
  feed_url         text,
  status           text    NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','published')),
  draft_status     text,
  draft_error      text,
  draft_started_at integer,
  published_at     integer,
  created_at       integer NOT NULL
);

-- Album membership on picks: a pick belongs to at most one album.
ALTER TABLE picks ADD COLUMN album_id text;
ALTER TABLE picks ADD COLUMN position_in_album integer NOT NULL DEFAULT 0;

CREATE INDEX picks_album_idx ON picks (album_id, position_in_album);
