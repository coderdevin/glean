-- 0019_discovery.sql
-- Add 'screened' to the submissions status CHECK and a `source` column.
-- SQLite cannot ALTER a CHECK in place (see 0008/0014), so rebuild the table.
-- Also create discovery_seen for the auto-discovery worker's dedup.

PRAGMA foreign_keys=OFF;

CREATE TABLE submissions_new (
  id                text    PRIMARY KEY,
  url               text    NOT NULL,
  note              text,
  submitter_name    text,
  submitter_ip_hash text,
  status            text    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','analyzing','composing','ready','published','rejected','failed','screened')),
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
  failure_stage     text CHECK (failure_stage IS NULL OR failure_stage IN ('extract','analysis','sections')),
  original_title    text,
  source            text NOT NULL DEFAULT 'manual'
);

INSERT INTO submissions_new (
  id, url, note, submitter_name, submitter_ip_hash, status, reject_reason,
  raw_r2_key, extracted_lang, ai_title_zh, ai_title_en, ai_summary_zh,
  ai_summary_en, ai_bullets_json, ai_tags_json, ai_category, ai_score,
  ai_model, ai_latency_ms, ai_tokens, editor_note_zh, editor_note_en,
  linked_pick_id, created_at, processed_at, reviewed_at, ai_subscores_json,
  ai_glossary_json, ai_next_hints_json, ai_sections_json,
  processing_started_at, processing_model, ai_sections_status,
  ai_sections_error, failure_stage, original_title
)
SELECT
  id, url, note, submitter_name, submitter_ip_hash, status, reject_reason,
  raw_r2_key, extracted_lang, ai_title_zh, ai_title_en, ai_summary_zh,
  ai_summary_en, ai_bullets_json, ai_tags_json, ai_category, ai_score,
  ai_model, ai_latency_ms, ai_tokens, editor_note_zh, editor_note_en,
  linked_pick_id, created_at, processed_at, reviewed_at, ai_subscores_json,
  ai_glossary_json, ai_next_hints_json, ai_sections_json,
  processing_started_at, processing_model, ai_sections_status,
  ai_sections_error, failure_stage, original_title
FROM submissions;

DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX submissions_status_idx ON submissions (status, created_at);

CREATE TABLE discovery_seen (
  url_normalized text PRIMARY KEY,
  source         text NOT NULL,
  first_seen_at  integer NOT NULL
);

PRAGMA foreign_keys=ON;
