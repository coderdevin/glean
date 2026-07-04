# 切片 2a · 导入幸福路径：一个 feed 端到端进专辑并自动发布

> 来源：`docs/prd-albums.md`。核心 tracer。遵循 `docs/adr/0002`（隔离每日流）、
> `docs/adr/0003`（导入绕过 discovery 门槛）。

## 构建内容

在专辑上点「导入」，读取其 `feed_url`，把 feed 里的文章推进现有 extract→LLM
管线；处理完**自动发布进该专辑**；读者在详情页按 feed 顺序看到成员，能打开任一
篇读双语正文。**仅含最简去重**（跳过已是 submission/pick 或批内重复的 URL）；
收编/跨专辑跳过留给切片 2b。

- 复用 `parseFeed` 把 feed XML 转成候选（PG 那种仅 `<link>`+`<title>` 的 feed
  也能解析）。
- 新 seam `planAlbumImport`（本片引入基础两分类；2b 扩展为三分类）：

  ```
  planAlbumImport(candidates, known, norm) ->
    { toEnqueue: Candidate[], skipped: {url, reason}[], positions: number[] }
  // 纯函数，注入 norm 与 known；本片只区分 enqueue / skip-already-known
  ```

- 入队到现有 `glean-ingest`，`submission.source = "album:<slug>"`。
- `processLlm` 对非 `auto:*` 源按 `manual` 全跑、**不做 gate-2 分数筛选**，故
  `album:*` 天然绕过门槛。
- **专辑版自动发布**：复用 `publishFieldsFromAi` 的 AI→字段映射，但写 pick 时设
  `album_id`、`position_in_album`（按导入顺序）、`daily_date = NULL`，**不**分配
  每日位置。
- **读者**：`/album/<slug>` 按 `position` 列出成员；`/a/<slug>` 对 album pick
  仅在其专辑 `status='published'` 时渲染，草稿专辑成员不可公开访问。
- **每日流隔离**：公开读取（首页 `homeFeed`、`dailyPicksForDate`、`searchPicks`、
  `picksForTag`、每日 RSS）统一加 `album_id IS NULL`。
- **缓存**：专辑发布时按 `bustForPick` 思路失效 `/album*` 及相关文章页。
- **失败**：抽取/LLM 失败的文章照旧留在 `failed` 队列并带原因，不静默丢弃。

## 验收标准

- [ ] 在专辑上点导入，feed 中新文章被入队并跑完 extract→LLM。
- [ ] 处理成功的文章自动成为该专辑成员（`album_id` 设值、`daily_date` 为空）。
- [ ] 详情页按 feed 顺序列出成员；能打开一篇看到中英双语正文。
- [ ] album pick **不**出现在首页 / `/daily` / 每日 RSS。
- [ ] 专辑仍是草稿时其成员 `/a/<slug>` 不可公开访问；发布后可访问。
- [ ] 重复导入同一 feed 不产生重复 pick（基础 URL 去重）。
- [ ] 失败文章留在 `failed` 队列并带原因。
- [ ] `planAlbumImport` 基础分区、`parseFeed`（仅 title+link 的 feed）有单测；
      `publishFieldsFromAi` 既有覆盖仍通过。

## Blocked by

- 切片 1（骨架 / schema）。
