-- Carry the article's source language through to published picks so the
-- article page can flip the modebar labels:
--   source=en (default): "中文译文 | 英文原文 | 对照"
--   source=zh:           "中文原文 | 英文译文 | 对照"
ALTER TABLE picks ADD COLUMN lang text;   -- "zh" | "en" | "other" | NULL
