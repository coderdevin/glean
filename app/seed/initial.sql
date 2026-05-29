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
