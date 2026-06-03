-- Capture the source article's own title on the submission.
--
-- Until now the extracted <title> was only stashed on the R2 object's
-- customMetadata (see ingest.ts processExtract) and used transiently as the
-- LLM title seed — it was never persisted as a queryable column, so the editor
-- never saw the original title to compare against the AI-rewritten ai_title_*.
-- This adds a plain, nullable column written at extract time. No CHECK, no
-- index needed — a simple ADD COLUMN (no table rebuild).
ALTER TABLE submissions ADD COLUMN original_title text;
