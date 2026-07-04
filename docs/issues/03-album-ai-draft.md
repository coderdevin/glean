# 切片 3 · 专辑 AI 起草标题/导语

> 来源：`docs/prd-albums.md`。复用 weekly 起草机制（`docs/adr/0001`）。

## 构建内容

复用 weekly 的异步起草机制，为专辑新增 `album` 起草分支：编辑在 admin 点
「AI 起草」，LLM 依据专辑成员文章生成中英**标题**与**导语**，写入 `draft_status`
异步态，完成后可编辑，读者详情页展示最终文案。

- LLM 侧新增 `album` 起草 kind（与现有 `weekly` / `weekly-refine` 并列）。
- admin 触发按钮 + 展示 `draft_status`（drafting / ready / failed）与 `draft_error`。
- 生成的 `title_zh/en`、`intro_zh/en` 可被编辑覆盖保存。
- 起草是**独立**动作：对一个已发布专辑起草，不应把它弄成不可用/下线。
- 专辑是**扁平有序列表**，无 weekly 的分节 `layout_json`——起草只产标题+导语。

## 验收标准

- [ ] 在有成员的专辑上点「AI 起草」，异步生成中英标题 + 导语。
- [ ] `draft_status` 正确流转（drafting→ready；失败→failed 带原因）。
- [ ] 起草不会把已就绪/已发布专辑弄成不可用。
- [ ] 编辑可修改生成结果并保存。
- [ ] 读者详情页显示最终标题/导语。
- [ ] 起草输出的纯函数解析/校正部分有单测。

## Blocked by

- 切片 2a（需要成员文章作为起草输入）。
