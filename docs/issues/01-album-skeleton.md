# 切片 1 · 专辑骨架：建空专辑并在读者端可见

> 来源：`docs/prd-albums.md`。遵循 `CONTEXT.md` 与 `docs/adr/0001..0003`。

## 构建内容

端到端最薄骨架：能在 admin 建一个**空专辑**，发布后读者能在 `/album` 索引和
`/album/<slug>` 详情看到它的标题/导语/封面（此时无成员文章）。草稿态专辑对读者
不可见。首页/每日流完全不受影响。

- **迁移**：新增 `albums` 表；`picks` 增加 `album_id`（可空 FK）+
  `position_in_album`；`picks.daily_date` 改为**可空**（Album Pick 无每日归属）。
- `albums` 表形状（编码本次设计决定）：

  ```
  albums:
    id, slug (unique),
    title_zh, title_en, intro_zh, intro_en,
    cover_image_key, feed_url,
    status ('draft' | 'published'),
    draft_status, draft_error, draft_started_at,   -- 复用 weekly 异步起草那套
    published_at, created_at
  ```

- **admin**：专辑列表页 + 新建/编辑表单（slug、中英标题、中英导语、`feed_url`、
  封面、草稿/发布开关）。本片不含导入。
- **读者**：`/album` 索引（列**已发布**专辑：封面 + 标题 + 篇数，此时篇数为 0）；
  `/album/<slug>` 详情（标题/导语/封面 + 空成员列表）。两者 **SSR**
  （`prerender=false`），`/album/` 尾斜杠变体登记进 astro 路由，使 `/en/album`
  与 `/en/album/<slug>` 可渲染。主导航加「专辑 / Albums」，与每日/每周并列。
- **可见性**：草稿专辑本身及其 `/album/<slug>` 对读者不可达（404）。

## 验收标准

- [ ] 迁移可在本地 D1 应用，且现有 `picks` 行不受影响（`daily_date` 仍在）。
- [ ] admin 能创建专辑并在草稿/发布间切换。
- [ ] 已发布空专辑出现在 `/album`，且其详情页可访问。
- [ ] 草稿专辑在 `/album` 与 `/album/<slug>` 两处都不可达。
- [ ] `/en/album` 与 `/en/album/<slug>` 正常渲染（不 500）。
- [ ] 导航出现「专辑」入口。
- [ ] 首页 / `/daily` / 每日 RSS 输出无回归（尚无 album 成员）。
- [ ] 专辑级可见性判定有纯函数单测（草稿隐藏、发布可见）。

## Blocked by

无 —— 可立即开始。
