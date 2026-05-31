# 自生长 Tag 词表 — 设计文档

**日期**: 2026-05-31
**状态**: 已批准，待实现

## 背景与问题

当前 tag 词表是人工 seed 的固定白名单（`app/seed/initial.sql`，仅 14 个 slug）。
ingest pipeline 对 LLM 产出的 tag 做严格白名单过滤（`app/src/lib/ingest.ts:352-353`），
LLM 自创的 tag 一律丢弃（进 `tagsDropped`）。prompt 也写死"只能从提供的 taxonomy
slug 里选，不要自创"（`app/src/lib/llm.ts:477`、`llm.ts:710`）。

**后果**：对一个 AI agent 类 GitHub 仓库，14 个 slug 里能匹配的只有
`agents / llm / ai / performance` —— 全是最泛的横切标签，没有细粒度可选项
（无 `rag` / `vector-db` / `cli` / `mcp` / `rust` / `compiler` …）。tag 质量低**不是
prompt 的问题，是词表太小太泛**，LLM 没得选。

## 目标

去掉固定白名单，让 LLM 按内容自由提取 tag，同时保持 tag 作为站点导航的可用性
（tag 落地页、family 分组、双语显示名）。词表从"死表"变为"随内容生长的活表"。

## 关键决策

1. **打标策略：自生长词表**。LLM 自由提 tag 并生成中英名 + family；prompt 注入现有
   tag 作为"优先复用，不合适才新建"的软提示。词表随内容生长且自然收敛 —— 热门概念
   复用旧 slug，新概念才加新的。
2. **新 tag 直接入库、立刻生效**（非待审池）。质量问题由后续的 admin 合并/改名工具
   兜底，而不是卡在审核上。

## 消费面（为何不能只删白名单）

tag 不只是标签，背后有落地页：
- `tags` 表每个 slug 带 `name_zh / name_en / family`（`app/src/db/schema.ts:109`）
- `/tag/[slug].astro`（文章聚合页）、`/tag/index.astro`（按 family 分组列全部 tag +
  文章数，`allTagsWithCounts` in `queries.ts:399`）
- 缓存 key 按 slug 分（`cache.ts`）

所以每个新 tag **必须自带中英名和 family**，否则落地页渲染不出来。

## 方案设计

### 1. LLM 输出结构变化

`tags` 从 `string[]`（仅 slug）改为带齐落地页字段的对象数组：

```jsonc
"tags": [
  { "slug": "rag", "name_zh": "检索增强", "name_en": "RAG", "family": "code" }
]
```

- `slug`：小写 kebab-case，纯 ascii（`vector-db`，非 `Vector DB`）
- `name_zh / name_en`：落地页双语显示名
- `family`：必须为 `infra | data | code` 之一（落地页按此分组）
- 数量：**3–6 个**（原为 1–3）；准确性优先于数量，贴切的不足 3 个时宁可少给，不凑数

涉及：
- zod schema（`llm.ts:262`）：`tags` 从 `z.array(z.string())` 改为对象数组 schema
- 普通文章 analysis prompt 的 tag 段（`llm.ts:476-479`）+ 输出 schema（`llm.ts:417`）
- GitHub analysis prompt 的 tag 段（`llm.ts:710`）+ 输出 schema（`llm.ts:694`）

两套 prompt 都改 —— 顺带提升普通文章的 tag 质量，不只 GitHub。

### 2. Prompt 软提示（收敛关键）

analysis 调用时把现有 tags 注入 prompt（slug + 中英名），措辞：
> "下面是已有的 tag，优先复用契合的；只有现有 tag 都不贴切时，才新建并补全中英名
> 和 family。"

注入策略：词表小（≤60）时全注入；超过 60 时按文章数 desc 取 top-60（热门 tag 永远
可见，保证复用倾向）。注入数据由 `ingest.ts` 在调 `callLlmAnalysis` 前从 DB 查出，
经现有 `taxonomy` 参数通道传入（参数类型需从 `string[]` 升级为带名字的对象）。

### 3. 入库逻辑（`ingest.ts` 重写）

> **实现发现**：`publish.ts:142-155` 在发布时本就会自动创建缺失的 tag（用
> `nameZh=slug`、`nameEn=TitleCase(slug)`、`family=文章category`）。`tags` 表本来就会
> 自生长，唯一卡点是 ingest 阶段的白名单过滤。据此细化如下：

替换 `taxonomySet.has(t)` 过滤，改为（`sanitizeProposedTags` in `src/lib/tags.ts` +
upsert）：
1. **校验+合法化**每个 tag（`sanitizeProposedTags`）：slug 小写化、空格/非 ascii 转
   `-`、去非法字符、去重、上限 6 个；family 不合法时回退到文章 category；缺失的
   中英名按 slug 派生。非法 slug 丢弃并记 log（`tagsDropped` 语义从"不在白名单"变为
   "格式非法"）。
2. **upsert（在 ingest 阶段）**：`INSERT INTO tags ... ON CONFLICT(slug) DO NOTHING`
   —— 用 LLM 写的双语名 + family 入库；已存在的 slug **保留原有名**，不被覆盖。
3. **`aiTagsJson` 继续只存 slug 数组**（`string[]`）。下游 `publish.ts` / admin 编辑 /
   缓存 / 查询全部零改动；`publish.ts` 的 auto-create 退化为几乎不触发的安全兜底。

### 4. 落地页 / 缓存

**零改动**。新 tag 在 ingest 阶段即入库（有 slug/名/family），`/tag/[slug]`、
`/tag/index`、`allTagsWithCounts`、缓存 key 全部照常工作。

## 不在本次范围

- **admin 合并/改名工具**（处理 `k8s` vs `kubernetes` 等近义 slug）—— 独立 spec 后续做。
- 现有 14 个 seed tag 保留不动，作为初始种子。

## 已知风险

无合并工具期间，近义 slug 会暂时并存（如 `llm` 与 `large-language-model`）。软提示的
复用倾向能压住大部分，剩余靠后续合并工具兜底。这是选择"直接入库"接受的代价。

## 验收

- 提交一个细分领域的 GitHub 仓库（如 RAG/向量库类），产出的 tag 含细粒度 slug 而非
  只有 `agents/llm/performance`。
- 新 slug 自动出现在 `tags` 表，对应 `/tag/[slug]` 落地页可访问、`/tag/index` 中按
  family 正确归类。
- 重复提交同领域内容时，复用已有 slug（不产生近义重复）。
- 已存在的人工 seed tag 名称不被 LLM 产出覆盖。
- 现有测试（含 `extract-github.test.ts`）保持通过；新增对 slug 合法化 + upsert 逻辑
  的单测。
