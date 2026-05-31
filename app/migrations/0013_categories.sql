-- Self-growing category taxonomy. Replaces the infra/data/code enum on
-- picks.category, submissions.ai_category and tags.family (those columns were
-- already plain TEXT — no column change needed). Categories also drive the
-- badge color system: the 3 originals keep their hand-tuned OKLCH colors (the
-- exact backgrounds from styles.css .badge--cat-*); new categories grow via
-- upsert at ingest with color = NULL (color derived from slug at render).
CREATE TABLE `categories` (
	`slug` text PRIMARY KEY NOT NULL,
	`name_zh` text NOT NULL,
	`name_en` text NOT NULL,
	`color` text
);

INSERT INTO categories (slug, name_zh, name_en, color) VALUES
  ('infra', '基础设施',    'Infrastructure',     'oklch(70% 0.083 175 / 16%)'),
  ('data',  '数据 / AI',   'Data / AI',          'oklch(75% 0.130 65 / 20%)'),
  ('code',  '工程 / 代码', 'Engineering / Code', 'oklch(63% 0.105 32 / 14%)')
ON CONFLICT(slug) DO NOTHING;
