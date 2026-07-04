# 切片 2b · 去重精修：收编无主 pick + 跨专辑跳过

> 来源：`docs/prd-albums.md`。遵循单专辑成员约束（`docs/adr/0001`）。

## 构建内容

把 `planAlbumImport` 从「enqueue / skip」扩展到**完整三分类**，并接上收编写路径：
导入时若某 URL 已是一个**无专辑归属**的 pick，则**收编**进本专辑（设 `album_id`
+ `position_in_album`）而不重新处理；若该 pick **已属别的专辑**，则**跳过**（绝不
移动，维持一个 pick 至多属一个专辑的约束）。

- `planAlbumImport` 扩展：

  ```
  planAlbumImport(candidates, known, norm) ->
    { toEnqueue, toAdopt: {url, pickId}[], skipped: {url, reason}[], positions }
  // known 现在描述每个已知 URL 的归属：
  //   在途 submission | 无主 pick | 已属某专辑的 pick
  ```

- **收编写路径**：给已存在的无主 pick 设 `album_id` + `position_in_album`，并失效
  相关缓存。收编不重新抽取、不产生新 pick。
- **跨专辑冲突**：归入 `skipped`，带明确 reason。

## 验收标准

- [ ] 导入时，之前发布过、无专辑归属的 pick 被收编进本专辑（不重复处理、不产生
      新 pick）。
- [ ] 已属别的专辑的 pick 被跳过，其 `album_id` 不被更改。
- [ ] 收编导致的成员变化会失效相关缓存。
- [ ] `planAlbumImport` 三分类有单测：批内去重、跳过在途、收编无主 pick、跨专辑
      跳过、位置随输入顺序。

## Blocked by

- 切片 2a（导入幸福路径 / `planAlbumImport` 基础版）。
