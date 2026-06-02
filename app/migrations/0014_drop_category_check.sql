-- Drop the infra/data/code CHECK on the category columns.
--
-- 0013 introduced the self-growing category taxonomy (categories table) and the
-- app now writes free-form category slugs: picks.category, submissions.ai_category,
-- and tags.family (see category.ts / tags.ts / publish.ts). But 0013's comment was
-- wrong — it claimed those columns "were already plain TEXT, no column change
-- needed". They were created in 0001/0008 WITH `CHECK (... IN ('infra','data','code'))`,
-- and 0013 never dropped them. So any LLM-proposed category outside the original
-- three hits: D1_ERROR: CHECK constraint failed: ai_category ... — and the
-- submission is marked failed (also latent on picks.category at publish and
-- tags.family at tag upsert).
--
-- SQLite can't ALTER-DROP a CHECK, so rebuild each table: same columns / order /
-- UNIQUE / indexes / OTHER checks (status, ai_sections_status, failure_stage),
-- only the category/family enum check removed. No foreign keys reference these
-- tables, so drop/rename is safe.

-- submissions: drop only the ai_category CHECK.
CREATE TABLE submissions_new (
  id                text    PRIMARY KEY,
  url               text    NOT NULL,
  note              text,
  submitter_name    text,
  submitter_ip_hash text,
  status            text    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','analyzing','composing','ready','published','rejected','failed')),
  reject_reason     text,
  raw_r2_key        text,
  extracted_lang    text,
  ai_title_zh       text,
  ai_title_en       text,
  ai_summary_zh     text,
  ai_summary_en     text,
  ai_bullets_json   text,
  ai_tags_json      text,
  ai_category       text,
  ai_score          real,
  ai_model          text,
  ai_latency_ms     integer,
  ai_tokens         integer,
  editor_note_zh    text,
  editor_note_en    text,
  linked_pick_id    text,
  created_at        integer NOT NULL,
  processed_at      integer,
  reviewed_at       integer,
  ai_subscores_json text,
  ai_glossary_json  text,
  ai_next_hints_json text,
  ai_sections_json  text,
  processing_started_at integer,
  processing_model  text,
  ai_sections_status text CHECK (ai_sections_status IN ('pending','ok','failed')),
  ai_sections_error text,
  failure_stage     text CHECK (failure_stage IS NULL OR failure_stage IN ('extract','analysis','sections'))
);
INSERT INTO submissions_new SELECT * FROM submissions;
DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX submissions_status_idx ON submissions (status, created_at);

-- picks: drop only the category CHECK (keep status check + dormant body_zh/body_en).
CREATE TABLE picks_new (
  id              text    PRIMARY KEY,
  slug            text    NOT NULL UNIQUE,
  title_zh        text    NOT NULL,
  title_en        text    NOT NULL,
  summary_zh      text    NOT NULL,
  summary_en      text    NOT NULL,
  bullets_json    text    NOT NULL DEFAULT '[]',
  editor_note_zh  text,
  editor_note_en  text,
  source_url      text    NOT NULL,
  source_host     text    NOT NULL,
  read_minutes    integer NOT NULL DEFAULT 5,
  category        text    NOT NULL,
  daily_date      text    NOT NULL,
  weekly_issue_id text,
  position_in_day integer NOT NULL DEFAULT 0,
  score           real    NOT NULL DEFAULT 0,
  submitter_name  text,
  body_zh         text,
  body_en         text,
  status          text    NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published')),
  published_at    integer,
  created_at      integer NOT NULL,
  glossary_json   text,
  next_hints_json text,
  sections_json   text,
  lang            text
);
INSERT INTO picks_new SELECT * FROM picks;
DROP TABLE picks;
ALTER TABLE picks_new RENAME TO picks;
CREATE INDEX picks_daily_idx  ON picks (daily_date, position_in_day);
CREATE INDEX picks_weekly_idx ON picks (weekly_issue_id);
CREATE INDEX picks_status_idx ON picks (status, published_at);

-- tags: drop the family CHECK.
CREATE TABLE tags_new (
  slug    text PRIMARY KEY,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  family  text NOT NULL
);
INSERT INTO tags_new SELECT * FROM tags;
DROP TABLE tags;
ALTER TABLE tags_new RENAME TO tags;
