-- Async weekly drafting. The AI draft (V4-Pro) takes 30s–2min, well past the
-- ~30s Cloudflare Pages SSR wall-clock cap. So generate/regenerate now enqueue
-- a `<id>|kind=weekly` message to the glean-llm queue (15-min worker budget)
-- and return immediately; the editor page polls these columns.

-- 'drafting' | 'ready' | 'failed'. Null = legacy issue drafted synchronously
-- before this migration; backfilled to 'ready' below.
ALTER TABLE weekly_issues ADD COLUMN draft_status text;

-- Human-readable failure reason shown in the editor when draft_status='failed'.
ALTER TABLE weekly_issues ADD COLUMN draft_error text;

-- When the current draft run started. Drives the editor's elapsed timer and the
-- cron watchdog that reaps drafts stranded past the worker wall-time ceiling.
ALTER TABLE weekly_issues ADD COLUMN draft_started_at integer;

-- Every existing issue already has a finished draft.
UPDATE weekly_issues SET draft_status = 'ready' WHERE draft_status IS NULL;
