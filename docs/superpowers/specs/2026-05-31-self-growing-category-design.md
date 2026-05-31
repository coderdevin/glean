# 自生长 Category + 自动配色 — 设计文档

**日期**: 2026-05-31
**状态**: 已批准，待实现

## 背景与问题

`category` 是 infra/data/code 三选一的硬 enum，固定在内容选品 prompt 与 DB 类型里。
实际内容已转向 AI/agents/LLM 为主，三个旧桶不贴合，逼着把所有东西塞进 code/infra。
延续 tags 的思路（见 [[prefer-llm-over-hardcoded-enums]]），让 category 也由 LLM
自由决定。

## 关键洞察

`picks.category` 与 `tags.family` 是**同一套分类**（同为 infra/data/code）。统一成一张
自生长的 `categories` 表，两者都引用它的 slug。

`text("category", { enum: CATEGORIES })` 的 enum **只是 Drizzle 的 TS 类型约束**——
SQLite 列本身是纯 TEXT，无 CHECK 约束。去掉 TS enum 不需要改列、不需要数据迁移。

## 目标

LLM 自由提 category（带中英名），新 category 自动入库并获得一个确定性配色，保持 badge
颜色扫描与 `/tag/index` 分组照常工作。infra/data/code 保留其手调品牌色，老内容零视觉变化。

## 消费面（category / family 当前用途）

- `badge--cat-{infra|data|code}`：3 个手调色 CSS 类（teal / amber / …），用于 badge 上色。
- `tags.family`：每个 tag 的色族（`a/[slug].astro`：`badge--cat-${t.family}`）。
- `picks.category`：文章 badge（`weekly/[id].astro`：`badge--cat-${p.category}` + `catLabel`）。
- `admin/[id].astro:529`：`<select name="category">` 固定 3 选项。
- `a/[slug].astro:110`：SEO `articleSection`。
- `/tag/index`：按 family 分组（`allTagsWithCounts`）。

## 方案设计

### 1. 新表 `categories`（`src/db/schema.ts`）

```
categories: slug (PK, text) · name_zh (text) · name_en (text) · color (text, nullable)
```
- seed infra/data/code，带其现有手调色 + 现有中英名（`seed/initial.sql`）。
- `color` 为空 → 渲染时按 slug hash 派生。

去掉 `picks.category` / `submissions.aiCategory` / `tags.family` 的 `{ enum: CATEGORIES }`
（保留为纯 `text`）。enum→text 无需数据迁移（SQLite 列本就是 TEXT）。

> **实现补充**：新表需要一个迁移（项目用 Cloudflare `wrangler d1 migrations apply`，
> 非 drizzle journal）。新增 `migrations/0013_categories.sql`：`CREATE TABLE categories`
> + seed infra/data/code（带手调色）。部署前必须 `wrangler d1 migrations apply glean
> --remote`，否则生产报 "no such table: categories"。`publish.ts` 也会在发布时 upsert
> 文章 category 进表（admin 可能手输新值）。

### 2. 纯函数模块 `src/lib/category.ts`（可单测）

- `normalizeCategorySlug(raw): string`——复用 tags 的 slug 规范化（小写 kebab ascii，
  去非法字符）。
- `sanitizeCategory(raw, fallbackSlug): { slug, nameZh, nameEn }`——校验 LLM 输出对象，
  规范化 slug，派生缺失中英名；空/非法回退到 fallback（默认 `code`）。
- `categoryColor(slug, storedColor?): string`——`storedColor` 优先；否则 `hash(slug)` →
  OKLCH 色相（固定 S/L），确定性出色。返回 CSS 颜色串。

### 3. analysis prompt（`llm.ts`，两套）

`category` 字段从 `"infra"|"data"|"code"` 改为对象
`{ slug, name_zh, name_en }`：根据内容自由命名，优先复用输入里「已有 category」。
注入「已有 category」列表（类似 tags 的软提示）。

`AnalysisResponseSchema.category` 从 `z.enum(...)` 改为宽松对象（或 `z.unknown()`，由
`sanitizeCategory` 做唯一校验，避免坏值整条 parse 失败）。call 函数里的 category clamp
（`llm.ts` 解析后 `if (!["infra","data","code"].includes(a.category)) a.category="code"`）
移除/改为 sanitize。

### 4. ingest 写入（`ingest.ts`）

- 注入：查 `categories` 表（slug + 名）传入 analysis（沿用 taxonomy 注入通道，或新增）。
- 解析后：`sanitizeCategory(analysis.output.category, "code")` → upsert 进 `categories`
  表（`onConflictDoNothing`，不覆盖已有名/色）→ `picks`/`submissions` 的 category 存 slug。
- tags 的 family：sanitizeProposedTags 产出的 family 现在也可以是任意 category slug；
  family 对应的 category 行若不存在也 upsert（family 名按 slug 派生即可）。

### 5. UI

- 新增渲染辅助（如 `categoryBadge` 数据：slug→{nameZh,nameEn,color}）。页面查 categories
  表拿名 + 色。
- `a/[slug].astro` / `weekly/[id].astro`：badge 从 `badge--cat-${x}` 类改为内联
  `style="--cat-color: {categoryColor(...)}"`（或直接 `background`）。保留 badge 基础类做
  形状/排版，仅颜色走内联。
- `admin/[id].astro`：`<select>` → `<input list>` datalist（已有 category 选项 + 可自由
  输入新值）。
- `/tag/index`：按 categories 表动态分组（不再硬编码 3 组）。

### 6. 测试

- TDD：`category.test.ts` 覆盖 `normalizeCategorySlug` / `sanitizeCategory` /
  `categoryColor`（确定性、手调色优先、回退）。
- `astro check` 0 error；全量 `scripts/*.test.ts` 通过。

## 不在范围

- 旧内容重新归类（infra/data/code 行保留，老 picks 不动）。
- admin 手动改 category 颜色 UI（自动配色够用；仅 seed 的 3 个有手调色）。
- category 的合并/改名工具（与 tags 一样，后续再说）。

## 已知影响 / 风险

- 改动面最大（新表 + ~10 文件类型/渲染 + 2 prompt + 配色），但无数据迁移，风险可控。
- 配色：category 多了会出现近似色（OKLCH 色相空间有限）；可接受，必要时后续手调 color 列。
- prompt 输出结构变化需两套 analysis prompt 同步改。

## 验收

- 提交一个 AI/agents 类内容，category 产出贴切的新 slug（如 `ai-agents`），自动入库并带色。
- 新 category 的 badge 有确定性颜色；infra/data/code 仍是原手调色。
- `/tag/index` 动态按现有 categories 分组。
- admin 编辑页可选已有 category 或自由输入新值。
- 老 picks / 老 tags 视觉与归类不变。
- `astro check` + 全量测试通过。
