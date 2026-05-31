# Admin 可编辑 Prompt + Provider 设置页 — 设计文档

**日期**: 2026-05-31
**状态**: 已批准，待实现

## 背景与问题

5 个 LLM 系统 prompt 现在 hardcode 在 `app/src/lib/llm.ts`（`ANALYSIS_SYSTEM_PROMPT`、
`SECTIONS_SYSTEM_PROMPT`、`GITHUB_ANALYSIS_SYSTEM_PROMPT`、`GITHUB_SECTIONS_SYSTEM_PROMPT`、
`WEEKLY_SYSTEM_PROMPT`）。调 prompt 必须改代码 + 重新部署。希望在 admin 加一个设置页，
可直接编辑 prompt 并立即生效。

LLM provider 切换目前在队列页（`admin/index.astro`），本次一并迁入统一设置页。

## 现有可复用基建

- `app_settings` D1 key/value 表（`schema.ts:275`），Pages app 与 queue worker 都可读写。
- `settings.ts` 已有 provider 读写模式（`getLlmProviderSetting` / `setLlmProviderSetting`，
  upsert via onConflictDoUpdate）。
- admin POST 走表单 action API 路由（`src/pages/api/admin/*`），如 `llm-provider.ts`。
- `Admin.astro` 顶栏 nav（队列 / 已通过 / 周刊）。

## 目标

admin 设置页 `/admin/settings`：编辑 5 个系统 prompt + 默认引擎切换。改动立即对新投稿
生效，无需部署。永不因 prompt 被改坏而让 pipeline 失灵。

## 关键机制：默认即兜底

`llm.ts` 的 5 个 hardcode 常量**保留为默认值**；DB 只存**覆盖值**。每次 LLM 调用用
`override ?? default`：
- 未自定义 → 用常量默认
- DB 读失败 / 覆盖值为空白 → 回落常量默认（安全网）
- "重置为默认" = 删除该 `app_settings` 行

## 方案设计

### 1. 模块边界（避免循环依赖）

- **`settings.ts`**：新增通用 `getSetting(db, key): Promise<string | null>` /
  `setSetting(db, key, value)` / `deleteSetting(db, key)`。纯 key/value，不依赖 llm 常量。
  现有 provider 函数保留。
- **`llm.ts`**：
  - 保留 5 个常量。
  - 新增纯函数 `resolvePrompt(override: string | null | undefined, fallback: string): string`
    —— trim 后非空用 override，否则 fallback。**可单测**。
  - 导出 `PROMPT_REGISTRY: { key, label, default }[]`（5 项），供 admin 页渲染。
  - 三个 call 函数（analysis / sections / weekly）在确定 systemPrompt 时：先按场景解析出
    prompt key，`getSetting(db, key)`，再 `resolvePrompt(override, 常量默认)`。
  - llm.ts 仅从 settings.ts 引入通用 getter（无值循环；settings.ts 不引入 llm 常量）。

  > 注意：call 函数需要 `db`。`LlmEnv` 已带 `DB`（queue worker 与 Pages handler 都绑定），
  > 在函数内 `env.DB` 即可。

### 2. prompt key ↔ 选择逻辑

5 个 key：`article_analysis` / `article_sections` / `github_analysis` /
`github_sections` / `weekly`。
当前 `isGithubHost(sourceHost) ? GITHUB_* : *` 的分支改为先解析出 key，再走
override→default 解析。

### 3. 页面 `src/pages/admin/settings.astro`

- **默认引擎**：从 `admin/index.astro` 原样迁入 provider 切换表单（复用
  `/api/admin/llm-provider`），并从 index 移除。
- **系统 Prompt**：遍历 `PROMPT_REGISTRY`，每项一个 `<form>` + `<textarea>`（预填当前
  有效值：override 存在则 override，否则 default）+ 保存按钮 + 重置为默认按钮。

### 4. 端点 `src/pages/api/admin/settings/prompt.ts`

POST 表单 `{ key, value, action? }`：
- key 必须在 `PROMPT_REGISTRY` 的 key 白名单内（拒绝任意 key 写入）。
- `action=reset` 或 value 空白 → `deleteSetting(db, key)`（回落默认）。
- 否则 `setSetting(db, key, value)`。
- 完成后 302 回 `/admin/settings`。

### 5. 导航

`Admin.astro` nav 加 `<a href="/admin/settings">设置</a>`。

### 6. 测试

- TDD：`resolvePrompt` 纯函数单测（override 优先、空白/ null 回落 default、trim）。
- `astro check` 0 error；全量 `scripts/*.test.ts` 通过。

## 不在范围

- prompt 版本历史 / 任意历史回滚（仅"重置为当前代码默认"）。
- model / temperature 调参。
- prompt 语法校验 / 试运行按钮（改坏只回落默认，足够安全）。

## 已知影响

- 每次 LLM 调用多一次 `app_settings` D1 读（queue worker，可忽略）。
- prompt key 白名单防止端点被写入任意 key。
- 空覆盖值视为"无覆盖"，是有意的安全回落。

## 验收

- `/admin/settings` 可见，nav 有"设置"入口。
- 编辑某个 prompt 保存后，新投稿用新 prompt（worker 每次调用查 override）。
- 重置后回落到代码默认；DB 行被删除。
- 默认引擎切换从设置页可用，队列页不再重复。
- prompt 被清空保存 → 安全回落默认，pipeline 不报错。
