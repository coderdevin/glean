# 自动发现管线 — Discovery Pipeline (MVP)

> 状态：设计已确认，待写实现计划
> 日期：2026-06-22
> 目标：把"每天手动找 link 提交到 `/submit`"这件累活自动化。系统已经能**评质量**（7 维 LLM 评分）和**人工签核**（发布前签字），缺的只是**发现**——自动找候选 URL 喂进现有评审队列。人工签核一字不动。

## 1. 核心思路

不重写 pipeline。新增一个定时 Worker，只负责给现有 pipeline 喂入口。候选链接走和 `/submit` **完全相同**的那条路（插入 `submissions` 行 + `env.INGEST.send(id)`），只是带上 `source` 标记并经过两道成本闸门。

```
cron (每天 2 次) → discovery worker
  → 各源 adapter 抓候选 URL (RSS / HN / arXiv)
  → 去重 (against submissions + picks + discovery_seen 表)
  → 【闸 1：廉价预评】批量 LLM，只看 标题+源站摘要 → 粗分，砍掉明显不行的
  → 存活者：插入 submissions(source="auto:<src>") + env.INGEST.send(id)
       → processExtract: fetch → R2          ← 现有代码，不改
       → processLlm phase 1: 写真实 aiScore   ← 现有代码，不改
       → 【闸 2】@ composing 拐点：
            auto 行 且 score < 0.7  → 状态 'screened'(带 reason)，不跑 phase 2
            否则                    → 照常 runSectionsPhase → 'ready'
       → editor 在 /admin 签核                ← 现有流程，不改
```

**为什么两道闸**：phase 2（双语正文 sections）是最贵的一步。闸 1 用近乎免费的标题预评把 firehose 源（arXiv/HN 每天几百条）砍到几十条，省掉在垃圾上花 extract 的网络/带宽；闸 2 用 phase 1 产出的**真实** 7 维分决定值不值得跑 phase 2。

## 2. 范围（已确认）

**MVP（本 spec）**
- 源：**RSS / 博客**、**Hacker News**、**arXiv**
- 两道闸门
- cron：**每天 2 次**
- 源列表：写在**配置文件**里（二期再搬进 admin）
- 低分（闸 2 未过）：**保留在 /admin 可见**，标记为 `screened`、带分数
- 去重表 `discovery_seen`

**二期（各自独立 spec，不在本次）**
- X / Twitter 发现（需不稳定的桥接，最难）
- Reddit
- `/admin` 可视化源管理
- 阈值 / 调度可调

## 3. 组件

### 3.1 新 Worker：`workers/discovery-consumer/`
与 `ingest-consumer` / `llm-consumer` 并列，复用同一套 D1 / R2 / Queue / LLM 绑定。

- **触发**：`wrangler.toml` 配 `[triggers] crons`，每天 2 次（如 `0 1,13 * * *` UTC）。
- **`scheduled()` handler** 顺序：
  1. 跑每个启用的 source adapter，收集候选 `{ url, title, snippet, source }`。
  2. `normalizeUrl` 后去重：跳过已在 `discovery_seen`、或已存在于 `submissions`（任何非终态/已发布）/ `picks` 的 URL。
  3. 把新候选写入 `discovery_seen`（无论后续是否入库，避免明天重复评分）。
  4. **闸 1**：批量喂给 LLM 粗评（一次调用评 N 条，只给标题+snippet），低于粗阈值的丢弃（仅记日志）。
  5. 存活者：对每条 `insert submissions(source="auto:<src>", status="pending")` + `env.INGEST.send(id)`。
- **隔离性**：每个 adapter 是独立函数，输入源配置、输出 `Candidate[]`，单独可测。一个源抓取失败不应中断其他源（各自 try/catch + 记日志）。

### 3.2 Source adapters
| 源 | 方式 | 配置项 |
|---|---|---|
| RSS / 博客 | 拉 feed XML，解析 entries | feed URL 列表 |
| Hacker News | HN Algolia API（`search_by_date`，按 points 过滤） | 最低分、tag |
| arXiv | arXiv API（按分类/关键词） | 分类列表、关键词 |

每个 adapter 返回 `Candidate { url, title, snippet, source }`。

### 3.3 配置文件
源列表（feed URL、HN 阈值、arXiv 分类、闸 1/闸 2 阈值）集中在一个 TS 配置文件（如 `workers/discovery-consumer/src/sources.ts`）。MVP 不做 UI。

### 3.4 闸 1：廉价预评
discovery worker 内，复用 `src/lib/llm.ts` 的 provider 抽象。一次 LLM 调用批量给候选打 0–1 粗分（prompt 只含标题 + 源站 snippet，**不** fetch 正文）。低于粗阈值（如 0.4）丢弃。目的是减量，不是定稿。

### 3.5 闸 2：真实分门槛（改 `src/lib/ingest.ts`）
现有 `processLlm` 在 phase 1 后写入 `aiScore` 并把状态置 `composing`（`ingest.ts` 约 427–441 行），随后进入 `runSectionsPhase`（phase 2）。

改动：在进入 phase 2 之前加判断——
- **仅当该行是 auto 发现**（`source` 以 `auto:` 开头）**且 `aiScore < 0.7`**：不跑 phase 2，把状态置为新状态 **`screened`**，写明 `reject_reason`（如 `auto-screened: score 0.62 < 0.7`）。
- 其他所有情况（含全部**手动提交**行）：行为不变，照常跑 phase 2。

**状态机纪律**（遵守 CLAUDE.md）：`screened` 是一个**独立的终态**，必须与人工 `rejected`、AI `failed` 区分开。它表示"AI 评分未达自动发布门槛、等人工定夺"，不是失败、也不是人工拒稿。reason 必填，editor 在 /admin 能看到。

## 4. 数据模型改动

1. `submissions` 加列 **`source TEXT NOT NULL DEFAULT 'manual'`**：取值 `manual` / `auto:hn` / `auto:rss:<id>` / `auto:arxiv`。用于闸 2 判定、/admin 显示来源、统计。
2. `SUBMISSION_STATUSES` 增加 **`screened`**（`app/src/db/schema.ts:10`）。这是跨切面改动：凡是按状态分组/过滤的地方（/admin 列表、reaper、统计）都要纳入。`screened` 行**不**进入 `picks`，除非 editor 人工提拔。
3. 新表 **`discovery_seen`**：`url_normalized TEXT PRIMARY KEY`、`first_seen_at`、`source`。用 `src/lib/normalize-url.ts` 的 `normalizeUrl` 归一化。

> 注：加 `screened` 状态会流经 admin UI / reaper / 统计——按 CLAUDE.md 视为 spec 级改动处理，逐处确认而非简单加枚举值。

## 5. /admin 改动
- 列表能筛 `source`（区分自动 vs 手动）和 `screened` 状态。
- `screened` 行显示分数和 reason；提供"人工提拔"动作（手动触发 phase 2，相当于覆盖闸 2）。
- 自动发现来的行在卡片上标注来源（如 `via HN`）。

## 6. 失败与可见性（遵守 CLAUDE.md）
- 每个 adapter 抓取失败：try/catch、记日志、不中断其他源。
- 闸 1 丢弃：记日志（丢了什么、为什么），不静默吞掉。
- 闸 2 `screened`：reason 必填、editor 可见。
- 复用现有 `markFailed` / reaper：auto 行在 extract/phase1 阶段失败的语义与手动行一致（`failed`，可重跑）。
- 每个 cron run 记一行汇总日志：各源抓了几条、去重后剩几条、闸 1 过几条、入库几条。

## 7. 成本与去重要点
- `discovery_seen` 防止每天对同一条 HN/RSS 条目重复评分（闸 1 也要钱）。
- 闸 1 批量评分（一次调用多条）摊薄成本。
- 闸 2 把最贵的 phase 2 挡在门外，只有 score≥0.7 才生成双语正文。
- 入库走 `env.INGEST.send`，**绕过** `/submit` 的 Turnstile / rate-limit（那是给公开表单防滥用的，内部入口不需要）。

## 8. 测试
沿用项目惯例（`app/scripts/*.test.ts`，`tsx` 跑）：
- 各 adapter：给定固定源响应 → 期望 `Candidate[]`（解析正确、字段齐全）。
- 去重逻辑：seen / 已存在 submissions / picks 的 URL 被正确跳过。
- 闸 2 判定：auto+低分→`screened`；auto+高分→`composing`→phase2；manual+任意分→phase2。
- 闸 1 批量评分解析：N 进 N 出，分数边界裁剪。

## 9. 部署
- 新 worker：`pnpm wrangler deploy -c workers/discovery-consumer/wrangler.toml`。
- `ingest.ts` 被两个 worker 共享——改了它要**同时**部署 ingest-consumer 和 llm-consumer。
- schema 改动：写 D1 migration，`pnpm db:migrate:local` 验证后再上远端。

## 10. 开放/二期
- X/Twitter 发现（桥接方案另议）。
- Reddit。
- 源管理搬进 /admin。
- 阈值随运行数据回看后调整（先用 0.7 主阈值 / 0.4 粗阈值）。
