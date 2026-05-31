-- Seed data. Only the tag taxonomy — demo picks / weekly issue removed
-- (they were prototype artifacts and showed up as "今日 · 3 条" defaults
-- on a fresh deploy; not real content). Tags are infrastructure: the
-- ingest pipeline whitelists submitted slugs against this table.
-- Apply on a fresh DB:
--   wrangler d1 execute glean --local --file=./seed/initial.sql
--   wrangler d1 execute glean --remote --file=./seed/initial.sql

INSERT INTO tags (slug, name_zh, name_en, family) VALUES
  ('edge',         'Edge',         'Edge',         'infra'),
  ('cloudflare',   'Cloudflare',   'Cloudflare',   'infra'),
  ('workers',      'Workers',      'Workers',      'infra'),
  ('infra',        '基础设施',     'Infra',        'infra'),
  ('database',     'Database',     'Database',     'data'),
  ('sqlite',       'SQLite',       'SQLite',       'data'),
  ('react',        'React',        'React',        'code'),
  ('framework',    '框架',         'Framework',    'code'),
  ('performance',  '性能',         'Performance',  'code'),
  ('typescript',   'TypeScript',   'TypeScript',   'code'),
  ('linux',        'Linux',        'Linux',        'code'),
  ('ai',           'AI',           'AI',           'code'),
  ('llm',          'LLM',          'LLM',          'code'),
  ('agents',       'Agents',       'Agents',       'code')
ON CONFLICT(slug) DO NOTHING;

-- Category taxonomy. The 3 originals keep their hand-tuned badge colors (the
-- exact OKLCH backgrounds from styles.css .badge--cat-*); new categories grow
-- via upsert at ingest with color = NULL (color derived from slug at render).
INSERT INTO categories (slug, name_zh, name_en, color) VALUES
  ('infra', '基础设施',    'Infrastructure',     'oklch(70% 0.083 175 / 16%)'),
  ('data',  '数据 / AI',   'Data / AI',          'oklch(75% 0.130 65 / 20%)'),
  ('code',  '工程 / 代码', 'Engineering / Code', 'oklch(63% 0.105 32 / 14%)')
ON CONFLICT(slug) DO NOTHING;
