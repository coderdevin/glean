-- Weekly issue layout: AI-themed sections + pick ordering, stored as JSON.
-- Shape: [{ "heading_zh": str, "heading_en": str, "pick_ids": [ulid, ...] }, ...]
-- This is the authoritative render source for /weekly/[number].
-- picks.weekly_issue_id remains the membership switch (set on save/publish).
ALTER TABLE weekly_issues ADD COLUMN layout_json text;
