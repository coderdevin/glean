# 专辑（Albums）· 本地 Issue 集

来源：`docs/prd-albums.md`。遵循 `CONTEXT.md`（Album / Feed / Album import）与
`docs/adr/0001..0003`。本地竖切片，未发布到 tracker。

## 依赖图

```
切片 1 (骨架)
   └─ 切片 2a (导入幸福路径)
         ├─ 切片 2b (去重/收编/跳过)
         ├─ 切片 3  (AI 起草标题/导语)
         └─ 切片 4  (编辑运营)
```

2b、3、4 只依赖 2a，彼此独立，可并行。

## 清单

1. [切片 1 · 专辑骨架](./01-album-skeleton.md)
2. [切片 2a · 导入幸福路径](./02a-import-happy-path.md)
3. [切片 2b · 去重/收编/跳过](./02b-dedup-adopt.md)
4. [切片 3 · 专辑 AI 起草标题/导语](./03-album-ai-draft.md)
5. [切片 4 · 编辑运营](./04-album-editorial-ops.md)

> 部署提醒（CLAUDE.md）：动到 `ingest.ts`（专辑版自动发布）需三个 worker
> 全部重新部署 + Pages；LLM 起草分支在 llm-consumer。
