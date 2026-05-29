-- Paragraph-level bilingual sections.
-- bullets_json stays for short card teasers; sections_json carries the
-- full-paragraph parallel reader content the article page renders.
--
-- The dead body_zh / body_en columns on picks were never written by the
-- pipeline; we leave them in place (SQLite ALTER DROP is fiddly and the
-- columns are nullable and unread).

ALTER TABLE submissions ADD COLUMN ai_sections_json text;
ALTER TABLE picks       ADD COLUMN sections_json    text;
