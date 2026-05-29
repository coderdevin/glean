-- AI output v2: subscores + glossary + next-read hints
-- Applied to: submissions (full AI output) and picks (only what's public-facing)

ALTER TABLE submissions ADD COLUMN ai_subscores_json text;
ALTER TABLE submissions ADD COLUMN ai_glossary_json  text;
ALTER TABLE submissions ADD COLUMN ai_next_hints_json text;

ALTER TABLE picks ADD COLUMN glossary_json   text;
ALTER TABLE picks ADD COLUMN next_hints_json text;
