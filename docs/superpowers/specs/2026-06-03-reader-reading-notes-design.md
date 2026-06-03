# 读者阅读笔记（划选 + 批注，跨设备同步）— 设计

> 日期：2026-06-03 · 状态：设计已对齐，待写实施计划

## 1. 目标

让读者在 `/a/[slug]` 站内阅读器里**边读边做读书笔记**：选中正文的一段话 → 高亮（三色可选）→ 可附一条批注。笔记按读者账号存在服务端，**跨设备同步、永久不丢**；读者可在"我的笔记"页跨文章回顾、导出。

## 2. 非目标 / v1 砍掉的（YAGNI）

- 无重叠高亮合并 —— 重叠的高亮各自渲染成嵌套 `<mark>`，接受轻微视觉重叠。
- 无"热门高亮"聚合（但 `reader_notes.pick_id` 留索引，为以后留路）。
- 无分享 / 社交。
- 批注为纯文本（不支持富文本 / markdown 渲染）。
- 导出仅 Markdown。
- 不碰 admin 鉴权：`src/middleware.ts` 的 `ADMIN_EMAILS` 闸门一个字都不改。

## 3. 范围与分期（P1 + P2 + P3 全进 v1）

| 期 | 内容 |
|---|---|
| **P1 读者身份** | magic-link 登录 + 会话 cookie + `readers` 表 |
| **P2 划选 + 批注** | `/a/[slug]` 选区工具条、三色高亮、批注 popover、`reader_notes` 表 + CRUD API、客户端重锚定与渲染 |
| **P3 我的笔记** | `/me/notes` 跨文章汇总 + 回跳定位 + Markdown 导出；`/me` 极简账号页（邮箱 + 登出） |

## 4. 读者身份（P1）

软鉴权，与 admin 闸门完全分离。公开页保持公开；只有笔记 API 与 `/me/*` 要求 reader 会话。

**新表 `readers`**

```sql
CREATE TABLE readers (
  id           text    PRIMARY KEY,        -- ULID
  email        text    NOT NULL UNIQUE,    -- 小写规范化
  created_at   integer NOT NULL,
  last_seen_at integer
);
```

**登录闭环**（全在 Pages 的 API 路由）：

1. `POST /api/reader/login` { email } → 规范化邮箱，IP 限流（复用 submissions 的 `submitterIpHash` 套路），用现有 `signToken` 签 `{ email, purpose: "login", exp: now+15min }`，经 `sendEmail`(Resend) 发出带 `/api/reader/verify?token=…` 的链接。无论邮箱是否已注册都返回相同的"已发送"响应（避免账号枚举）。
2. `GET /api/reader/verify?token=…` → `verifyToken` + 过期校验 + `purpose==="login"`；通过则 upsert `readers`（按 email），下发会话 cookie，302 回文章页或 `/me/notes`。
3. **会话 cookie `glean_reader`**：`signToken` 签 `{ readerId, iat }`，`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=90d`；滚动续期。
4. `POST /api/reader/logout` → 清 cookie。
5. `GET /api/reader/me` → 返回 `{ email }` 或 401（客户端判登录态用）。

**辅助函数** `readReaderSession(request): { readerId } | null`（`src/lib/reader-auth.ts`）—— 解析并验证 cookie，供 API 与 `/me/*` 使用。**不进 middleware 主链路。**

**密钥**：新增 `READER_SESSION_SECRET`（magic-link 令牌与会话 cookie 共用或各一把，实施时定）。

**安全**：

- 令牌短过期（15 min）+ 绑定 email；可选用 KV 记录已用 nonce 防重放（实施时定，非阻塞）。
- 笔记/账号操作一律按会话 `reader_id` 授权，**绝不接受前端传来的 reader_id**。
- SameSite=Lax + 同源 JSON POST 防 CSRF；写操作额外校验 `Origin` 头。
- 输入长度上限：note、exact、prefix、suffix 各设上限。

## 5. 划选 + 批注（P2）

### 5.1 数据模型

**新表 `reader_notes`**

```sql
CREATE TABLE reader_notes (
  id            text    PRIMARY KEY,        -- ULID
  reader_id     text    NOT NULL,
  pick_id       text    NOT NULL,
  section_index integer NOT NULL,           -- 1-based，对应 a/[slug] 的 row-{i}/data-pair
  lang          text    NOT NULL,           -- 'zh' | 'en'，高亮所在语言窗格
  exact         text    NOT NULL,           -- 高亮的原文引用
  prefix        text,                        -- 引用前若干字（消歧）
  suffix        text,                        -- 引用后若干字（消歧）
  start_offset  integer NOT NULL,            -- 该段纯文本内的字符偏移（快速命中提示）
  color         text    NOT NULL DEFAULT 'yellow', -- 'yellow' | 'green' | 'pink'
  note          text,                        -- 批注；NULL = 纯高亮
  created_at    integer NOT NULL,
  updated_at    integer NOT NULL
);
CREATE INDEX reader_notes_reader_pick_idx ON reader_notes (reader_id, pick_id);
CREATE INDEX reader_notes_pick_idx        ON reader_notes (pick_id);          -- 为未来聚合留
CREATE INDEX reader_notes_reader_idx      ON reader_notes (reader_id, created_at); -- 我的笔记列表
```

三色：`yellow` / `green` / `pink`（CSS class `rn-hl--{color}`）。

### 5.2 锚定模型（技术核心）

笔记锚定到 `(pick_id, section_index, lang)` + **文本引用**（Hypothesis/Readwise 式），不依赖死偏移：

- **保存时**：记录 `exact`、`prefix`/`suffix`（前后各 ~32 字）、`start_offset`（段内纯文本字符偏移）。
- **加载重锚定**（客户端）：
  1. 取该 `(section_index, lang)` 对应 `.av2-prose` 容器的纯文本。
  2. 先按 `start_offset` 命中并校验 `exact` 是否一致 → 命中即用。
  3. 否则用 `exact`（必要时配 `prefix`/`suffix` 消歧）在段内搜索 → 命中即用，并刷新 offset。
  4. 都找不到（编辑重发布改动过大）→ 标记 **orphaned**：文章里**不**高亮，但"我的笔记"里仍按保存的 `exact` 展示，不丢。

orphaned 为加载时计算的运行时状态，不落库（避免陈旧）。

### 5.3 渲染

- 高亮**不烤进存储的 HTML**（否则与 markdown-it 重渲染冲突）。
- 客户端在 `.av2-prose` 渲染后走文本节点，把命中区间包成 `<mark class="rn-hl rn-hl--{color}" data-note-id="…">`。
- **双语独立**：中文窗格（`.av2-trans`）划的线只在中文显示；英文窗格（`.av2-orig`）同理 —— 两个窗格是不同译文，本应分开。
- 有批注的高亮在右边距挂 📝 指示符。

### 5.4 交互

- 选中正文文本 → 选区附近浮起小工具条：`[● 黄 ● 绿 ● 粉] [批注]`。
- 点颜色 → 立即 `POST /api/reader/notes` 落库 + 包 `<mark>`。
- 点已有高亮 → 弹 popover：读/改/删批注、改色、删高亮。
- **未登录就划线** → 就地弹邮箱登录框；登录回来后把挂起的选区补提交（选区信息暂存在内存/sessionStorage）。

### 5.5 API（全部强制 reader 会话，reader_id 只认 cookie）

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/reader/notes` | 建高亮/批注。body: `{ pickId, sectionIndex, lang, exact, prefix, suffix, startOffset, color, note? }` → 返回 `{ id }` |
| `PATCH` | `/api/reader/notes/:id` | 改 `note` / `color`（先校验该 note 属于会话 reader） |
| `DELETE` | `/api/reader/notes/:id` | 删（先校验归属） |
| `GET` | `/api/reader/notes?pickId=…` | 列出本读者在该文章的全部笔记（页面 hydrate 用），`Cache-Control: no-store` |

## 6. 缓存（必须做对）

`/a/[slug]` 当前公开 CDN 缓存。笔记按人不同，**绝不 SSR 进页面**（会缓存污染 / 串号）。

**决定**：页面对所有人**完全相同 + 保持公开可缓存**；笔记走客户端 `GET /api/reader/notes?pickId`（`no-store`，`credentials: include`）拉取后叠加渲染。代价：高亮在 DOMContentLoaded 后晚一瞬出现，可接受。`bustForPick()` 不受影响。登录态同样客户端判（`/api/reader/me`）。

## 7. "我的笔记" / 账号（P3）

- `/me/notes`（SSR, `prerender=false`, reader-gated；未登录跳登录）：按文章分组列出该读者全部高亮 + 批注，新→旧。每条显示引用原文 + 批注 + 回跳文章并定位高亮（`/a/<slug>#note-<id>`，到页后滚动 + 闪一下）。导出：一键复制全部为 Markdown。
- `/me`（SSR, reader-gated）：极简账号页 —— 邮箱 + 登出。

## 8. i18n / 路由

- 新页面（登录入口、`/me`、`/me/notes`）一律 `export const prerender = false`（SSR），`/en/*` 变体可达，文案走 `<Lang>` / `localizedPath`。
- 遵守站点无尾斜杠规范；若新增 exact-match SSR 页，按需登记 `astro.config.mjs` 的 `routes.extend.include`。

## 9. 迁移 & 部署

- **迁移**：一个新迁移建 `readers` + `reader_notes`（纯建表，无表重建）。
- **部署面**：整个功能都在 **Pages**（`src/pages`、`src/pages/api`、components、`src/lib`）。ingest / llm 两个 worker **不动** —— 单面部署：
  ```sh
  pnpm wrangler d1 migrations apply glean --remote
  pnpm build && pnpm wrangler pages deploy ./dist
  ```
- **新环境变量/密钥**：`READER_SESSION_SECRET`。

## 10. 成功标准

1. 未登录读者在 `/a/[slug]` 选中文本可发起高亮，触发就地登录；登录后高亮成功落库并立即出现。
2. 换一台设备 / 浏览器登录同一邮箱，能看到同一篇文章的全部高亮与批注。
3. 三色高亮可选、可改色、可加/改/删批注、可删高亮。
4. 中英文窗格高亮互不串。
5. `/me/notes` 跨文章汇总，能回跳并定位到具体高亮，能导出 Markdown。
6. 编辑重发布文章后，仍能命中的高亮正常重锚；命中不了的变 orphaned，在"我的笔记"保留不丢。
7. `/a/[slug]` 仍公开可缓存，不同读者互不串号。
8. admin 鉴权与 ingest/llm worker 行为零变化。

## 11. 已解决的关键取舍

- **身份**：邮箱 magic-link（复用 `signToken`/`verifyToken` + Resend），不引第三方 OAuth。
- **锚定**：文本引用 + orphan 兜底，抗"重新发布"。
- **缓存**：客户端叠加笔记，换取缓存层与隐私干净。
- **配色**：3 色固定调色板（黄/绿/粉）。
- **范围**：P1 + P2 + P3 全进 v1。
