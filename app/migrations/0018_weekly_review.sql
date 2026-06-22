-- On-demand editorial self-review for weekly issues. After a draft is 'ready',
-- the editor can ask the LLM to critique it (做得好 / 做得不好 / 改进方向), edit
-- the improvement directive, then trigger a feedback-guided re-draft
-- (`<id>|kind=weekly-refine`) that re-shapes title/intro/sections while keeping
-- the SAME linked picks.
--
-- review_status is INDEPENDENT of draft_status: generating or failing a review
-- never changes the draft's readiness. Both review and refine run async through
-- the glean-llm queue, same as drafting.

-- Structured LLM critique: {"strengths":[...],"weaknesses":[...],"suggestions":"..."}.
ALTER TABLE weekly_issues ADD COLUMN review_json text;

-- null | 'reviewing' | 'ready' | 'failed'. Null = no review run yet.
ALTER TABLE weekly_issues ADD COLUMN review_status text;

-- Human-readable failure reason shown in the editor when review_status='failed'.
ALTER TABLE weekly_issues ADD COLUMN review_error text;

-- Editor-editable 改进方向, seeded from the LLM's suggestions and consumed by
-- the weekly-refine re-draft.
ALTER TABLE weekly_issues ADD COLUMN review_feedback text;

-- When the current review run started. Drives the cron watchdog that reaps
-- reviews stranded in 'reviewing' past the wall-time ceiling (mirrors
-- draft_started_at / reapStalledWeeklyDrafts).
ALTER TABLE weekly_issues ADD COLUMN review_started_at integer;
