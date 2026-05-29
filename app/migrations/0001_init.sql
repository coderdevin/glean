-- Glean schema --- generated from src/db/schema.ts.
-- Apply with: wrangler d1 migrations apply glean --local (or --remote)

CREATE TABLE picks (
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
  category        text    NOT NULL CHECK (category IN ('infra','data','code')),
  daily_date      text    NOT NULL,
  weekly_issue_id text,
  position_in_day integer NOT NULL DEFAULT 0,
  score           real    NOT NULL DEFAULT 0,
  submitter_name  text,
  body_zh         text,
  body_en         text,
  status          text    NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published')),
  published_at    integer,
  created_at      integer NOT NULL
);
CREATE INDEX picks_daily_idx  ON picks (daily_date, position_in_day);
CREATE INDEX picks_weekly_idx ON picks (weekly_issue_id);
CREATE INDEX picks_status_idx ON picks (status, published_at);

CREATE TABLE weekly_issues (
  id                text    PRIMARY KEY,
  number            integer NOT NULL UNIQUE,
  slug              text    NOT NULL UNIQUE,
  title_zh          text    NOT NULL,
  title_en          text    NOT NULL,
  date_start        text    NOT NULL,
  date_end          text    NOT NULL,
  intro_zh          text    NOT NULL,
  intro_en          text    NOT NULL,
  cover_image_key   text,
  published_at      integer,
  created_at        integer NOT NULL
);

CREATE TABLE tags (
  slug    text PRIMARY KEY,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  family  text NOT NULL CHECK (family IN ('infra','data','code'))
);

CREATE TABLE pick_tags (
  pick_id  text NOT NULL,
  tag_slug text NOT NULL,
  PRIMARY KEY (pick_id, tag_slug)
);
CREATE INDEX pick_tags_tag_idx ON pick_tags (tag_slug);

CREATE TABLE submissions (
  id                text    PRIMARY KEY,
  url               text    NOT NULL,
  note              text,
  submitter_name    text,
  submitter_ip_hash text,
  status            text    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','ready','published','rejected')),
  reject_reason     text,
  raw_r2_key        text,
  extracted_lang    text,
  ai_title_zh       text,
  ai_title_en       text,
  ai_summary_zh     text,
  ai_summary_en     text,
  ai_bullets_json   text,
  ai_tags_json      text,
  ai_category       text CHECK (ai_category IS NULL OR ai_category IN ('infra','data','code')),
  ai_score          real,
  ai_model          text,
  ai_latency_ms     integer,
  ai_tokens         integer,
  editor_note_zh    text,
  editor_note_en    text,
  linked_pick_id    text,
  created_at        integer NOT NULL,
  processed_at      integer,
  reviewed_at       integer
);
CREATE INDEX submissions_status_idx ON submissions (status, created_at);

CREATE TABLE subscribers (
  email         text PRIMARY KEY,
  lang_pref     text NOT NULL CHECK (lang_pref IN ('zh','en')),
  source        text NOT NULL,
  confirm_token text,
  confirmed_at  integer,
  created_at    integer NOT NULL
);

CREATE TABLE article_annotations (
  id       text    PRIMARY KEY,
  pick_id  text    NOT NULL,
  anchor   text    NOT NULL,
  body_zh  text    NOT NULL,
  body_en  text    NOT NULL,
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX annotations_pick_idx ON article_annotations (pick_id, position);
