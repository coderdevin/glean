-- Split the single LLM call into two phases (analysis + sections). Analysis
-- now flips submission → 'ready'; sections runs second and can fail without
-- blocking review. These columns surface the sections phase state so admin
-- can see why publish is gated and retry just the sections pass.

ALTER TABLE submissions ADD COLUMN ai_sections_status text
  CHECK (ai_sections_status IN ('pending','ok','failed'));
ALTER TABLE submissions ADD COLUMN ai_sections_error text;

-- Backfill: rows already in 'ready' or 'published' must have completed the
-- old single-call pipeline (which always produced sections), so mark them
-- 'ok'. Leaving them NULL would cause publish to start refusing to ship
-- previously-ready submissions after this migration.
UPDATE submissions
SET ai_sections_status = 'ok'
WHERE status IN ('ready','published')
  AND ai_sections_status IS NULL;
