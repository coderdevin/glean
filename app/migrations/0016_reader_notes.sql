-- Reader accounts + reading notes (highlight + annotate, cross-device sync).
--
-- Distinct from the admin gate: `readers` identifies public readers via a
-- passwordless magic-link login so their notes follow them across devices.
-- `reader_notes` stores text-quote-anchored highlights (+ optional annotation)
-- against published picks. Plain ADD-style creates, no table rebuild.
CREATE TABLE readers (
  id           text    PRIMARY KEY,        -- ULID
  email        text    NOT NULL UNIQUE,    -- lowercased
  created_at   integer NOT NULL,
  last_seen_at integer
);

CREATE TABLE reader_notes (
  id            text    PRIMARY KEY,        -- ULID
  reader_id     text    NOT NULL,
  pick_id       text    NOT NULL,
  section_index integer NOT NULL,           -- 1-based, matches a/[slug] row-{i}
  lang          text    NOT NULL CHECK (lang IN ('zh','en')),
  exact         text    NOT NULL,           -- highlighted quote
  prefix        text,                        -- chars before the quote
  suffix        text,                        -- chars after the quote
  start_offset  integer NOT NULL,            -- char offset hint within section text
  color         text    NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow','green','pink')),
  note          text,                        -- annotation; NULL = highlight only
  created_at    integer NOT NULL,
  updated_at    integer NOT NULL
);
CREATE INDEX reader_notes_reader_pick_idx ON reader_notes (reader_id, pick_id);
CREATE INDEX reader_notes_pick_idx        ON reader_notes (pick_id);
CREATE INDEX reader_notes_reader_idx      ON reader_notes (reader_id, created_at);
