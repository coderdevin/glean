-- Status state-machine redesign: collapse `status` + `ai_sections_status` into
-- a single 7-state axis (pending|analyzing|composing|ready|published|rejected|
-- failed). See docs/superpowers/specs/2026-05-29-submission-status-machine-design.md.
--
-- The submissions table carries a CHECK (status IN (...old 5...)), and SQLite
-- cannot ALTER a CHECK in place, so this is a full table rebuild: create a new
-- table with the 7-state CHECK + a `failure_stage` column, copy rows while
-- remapping status/failure_stage/reject_reason/ai_sections_error inline (the
-- CASE logic mirrors src/lib/submissionStatus.ts::mapLegacyStatus, unit-tested),
-- drop the old table, rename, and recreate the one user index. No foreign keys
-- reference submissions, so the drop/rename is safe.

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

INSERT INTO submissions_new (
  id, url, note, submitter_name, submitter_ip_hash,
  status, reject_reason, raw_r2_key, extracted_lang,
  ai_title_zh, ai_title_en, ai_summary_zh, ai_summary_en, ai_bullets_json, ai_tags_json,
  ai_category, ai_score, ai_model, ai_latency_ms, ai_tokens,
  editor_note_zh, editor_note_en, linked_pick_id, created_at, processed_at, reviewed_at,
  ai_subscores_json, ai_glossary_json, ai_next_hints_json, ai_sections_json,
  processing_started_at, processing_model, ai_sections_status, ai_sections_error, failure_stage
)
SELECT
  id, url, note, submitter_name, submitter_ip_hash,
  -- status remap (mirrors mapLegacyStatus)
  CASE
    WHEN status = 'processing' THEN 'analyzing'
    WHEN status = 'ready' AND ai_sections_status = 'pending' THEN 'composing'
    WHEN status = 'ready' AND ai_sections_status = 'failed' THEN 'failed'
    WHEN status = 'ready' AND ai_sections_status IS NULL
         AND (ai_sections_json IS NULL
              OR json_valid(ai_sections_json) = 0
              OR (SELECT count(*) FROM json_each(ai_sections_json)
                  WHERE trim(coalesce(json_extract(value, '$.body_zh'), '')) <> ''
                     OR trim(coalesce(json_extract(value, '$.body_en'), '')) <> '') = 0)
         THEN 'failed'
    WHEN status = 'rejected' AND (reject_reason LIKE 'llm:%' OR reject_reason LIKE 'extract:%') THEN 'failed'
    ELSE status  -- pending | published | ready(ok or null+valid) | rejected(editor)
  END AS status,
  -- reject_reason: drop the AI-failure reasons (moved to ai_sections_error),
  -- strip the 'editor:' prefix from genuine editor rejections, else keep.
  CASE
    WHEN status = 'rejected' AND (reject_reason LIKE 'llm:%' OR reject_reason LIKE 'extract:%') THEN NULL
    WHEN status = 'rejected' AND reject_reason LIKE 'editor:%' THEN ltrim(substr(reject_reason, 8))
    ELSE reject_reason
  END AS reject_reason,
  raw_r2_key, extracted_lang,
  ai_title_zh, ai_title_en, ai_summary_zh, ai_summary_en, ai_bullets_json, ai_tags_json,
  ai_category, ai_score, ai_model, ai_latency_ms, ai_tokens,
  editor_note_zh, editor_note_en, linked_pick_id, created_at, processed_at, reviewed_at,
  ai_subscores_json, ai_glossary_json, ai_next_hints_json, ai_sections_json,
  processing_started_at, processing_model, ai_sections_status,
  -- ai_sections_error: carry the moved AI-failure reason, else keep existing.
  CASE
    WHEN status = 'rejected' AND (reject_reason LIKE 'llm:%' OR reject_reason LIKE 'extract:%') THEN reject_reason
    ELSE ai_sections_error
  END AS ai_sections_error,
  -- failure_stage: only set for rows that map to 'failed'.
  CASE
    WHEN status = 'ready' AND ai_sections_status = 'failed' THEN 'sections'
    WHEN status = 'ready' AND ai_sections_status IS NULL
         AND (ai_sections_json IS NULL
              OR json_valid(ai_sections_json) = 0
              OR (SELECT count(*) FROM json_each(ai_sections_json)
                  WHERE trim(coalesce(json_extract(value, '$.body_zh'), '')) <> ''
                     OR trim(coalesce(json_extract(value, '$.body_en'), '')) <> '') = 0)
         THEN 'sections'
    WHEN status = 'rejected' AND reject_reason LIKE 'extract:%' THEN 'extract'
    WHEN status = 'rejected' AND reject_reason LIKE 'llm:%' THEN 'analysis'
    ELSE NULL
  END AS failure_stage
FROM submissions;

DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX submissions_status_idx ON submissions (status, created_at);
