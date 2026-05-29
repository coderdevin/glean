/**
 * Provider-agnostic LLM client for the ingest pipeline.
 *
 * Both OpenAI and DeepSeek implement the same OpenAI Chat Completions API,
 * so one client supports both with just a base-URL + model swap.
 *
 * The pipeline runs in two phases against the same provider:
 *
 *   1. analysis — title / summary / bullets / tags / score / glossary / next_hints.
 *      Small output, fast to verify, used to flip submission → 'ready'.
 *
 *   2. sections — bilingual section breakdown of the article body. Big output;
 *      runs after analysis succeeds. A failure here does NOT block 'ready',
 *      only publish — admin can retry sections independently.
 *
 * Splitting these into two calls keeps each output well below the model's
 * max_tokens budget. The original single-call schema was hitting truncation
 * on long articles, producing unparseable JSON.
 *
 * Selection priority:
 *   1. env.LLM_PROVIDER (explicit, "openai" | "deepseek")
 *   2. Auto: whichever of OPENAI_API_KEY / DEEPSEEK_API_KEY is set
 *
 * Overrides:
 *   env.LLM_MODEL     — override the default model name
 *   env.LLM_BASE_URL  — override the API base URL (useful for proxies)
 */

import { z } from "zod";

export interface LlmEnv {
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  /** When set, automatically retry once with this model on 429 / 5xx / timeout.
   *  Skipped if the caller passed an explicit modelOverride (respect explicit
   *  intent — if admin picked V4-Pro, don't silently demote to V4-Flash). */
  LLM_FALLBACK_MODEL?: string;
  /** Optional R2 bucket for dumping raw LLM stream output on parse failure
   *  (so the editor can debug / hand-repair without re-running the model). */
  RAW?: R2Bucket;
}

/**
 * Marker prefix carried in error messages from this module. The queue worker
 * checks for it and skips retry — the same prompt + truncated output will
 * fail again the same way, so retrying just doubles the bill.
 */
export const NO_RETRY_MARKER = "[no-retry]";

export type LlmPhase = "analysis" | "sections";

/** Best-effort dump of the raw LLM stream output to R2. */
async function dumpLlmFailure(
  env: LlmEnv,
  args: {
    phase: LlmPhase;
    provider: string;
    submissionId?: string;
    rawContent: string;
    reasoning: string;
    tokens: number | null;
    parseError: string;
  },
): Promise<string | null> {
  if (!env.RAW) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `llm-fail/${args.submissionId ?? "unknown"}-${args.phase}-${ts}.txt`;
  const payload = [
    `# LLM parse failure`,
    `phase: ${args.phase}`,
    `provider: ${args.provider}`,
    `submission: ${args.submissionId ?? "—"}`,
    `tokens: ${args.tokens ?? "?"}`,
    `parse error: ${args.parseError}`,
    `reasoning chars: ${args.reasoning.length}`,
    ``,
    `---- raw content ----`,
    args.rawContent,
  ].join("\n");
  try {
    await env.RAW.put(key, payload, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    return key;
  } catch (err) {
    console.warn("R2 dump failed (ignored):", (err as Error).message);
    return null;
  }
}

export interface LlmProvider {
  name: "openai" | "deepseek";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function pickProvider(env: LlmEnv): LlmProvider {
  const explicit = env.LLM_PROVIDER?.toLowerCase();
  const wantOpenAI = explicit === "openai" || (!explicit && env.OPENAI_API_KEY);
  const wantDeepSeek = explicit === "deepseek" || (!explicit && env.DEEPSEEK_API_KEY);

  if (wantOpenAI && env.OPENAI_API_KEY) {
    return {
      name: "openai",
      baseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1/chat/completions",
      apiKey: env.OPENAI_API_KEY,
      model: env.LLM_MODEL || "gpt-4o-mini",
    };
  }
  if (wantDeepSeek && env.DEEPSEEK_API_KEY) {
    return {
      name: "deepseek",
      baseUrl: env.LLM_BASE_URL || "https://api.deepseek.com/v1/chat/completions",
      apiKey: env.DEEPSEEK_API_KEY,
      // V4-Pro is the current flagship reasoning model. `deepseek-chat` /
      // `deepseek-reasoner` are scheduled for deprecation on 2026-07-24.
      model: env.LLM_MODEL || "deepseek-v4-pro",
    };
  }
  if (explicit) {
    throw new Error(
      `LLM_PROVIDER=${explicit} but the matching API key is not set ` +
        `(${explicit === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY"})`,
    );
  }
  throw new Error("no LLM provider configured: set OPENAI_API_KEY or DEEPSEEK_API_KEY");
}

/* ============================================================
 * Schemas
 * ============================================================ */

// LLMs (DeepSeek in particular) frequently emit `"field": null` for what they
// consider "no value", instead of omitting the field. Plain `.optional()`
// accepts only `string | undefined` and Zod rejects null with
// "Expected string, received null", failing the whole parse.
// Use `.nullish()` (= nullable + optional) wherever the field is a hint, not
// a required signal — null and missing are equivalent for our purposes.
const AnalysisResponseSchema = z.object({
  title_zh: z.string().min(1),
  title_en: z.string().min(1),
  summary_zh: z.string().min(1),
  summary_en: z.string().min(1),
  bullets: z.array(z.object({ zh: z.string(), en: z.string() })).default([]),
  tags: z.array(z.string()).default([]),
  category: z.enum(["infra", "data", "code"]),
  score: z.number().min(0).max(1).default(0.5),
  detected_lang: z.enum(["zh", "en", "other"]).nullish(),
  subscores: z
    .object({
      novelty: z.number().min(0).max(1).default(0.5),
      depth: z.number().min(0).max(1).default(0.5),
      evidence: z.number().min(0).max(1).default(0.5),
      effort: z.number().min(0).max(1).default(0.5),
      audience_fit: z.number().min(0).max(1).default(0.5),
      utility: z.number().min(0).max(1).default(0.5),
      bias: z.number().min(0).max(1).default(0.0),
    })
    .nullish(),
  glossary: z
    .array(
      z.object({
        en: z.string(),
        zh: z.string(),
        meaning: z.string(),
        anchor: z.string().nullish(),
      }),
    )
    .default([]),
  next_hints: z.array(z.string()).default([]),
});

const SectionsResponseSchema = z.object({
  sections: z
    .array(
      z.object({
        // Loose minimums + a default — a single misshapen section from the
        // LLM (empty heading, missing body) shouldn't poison the whole
        // output. We filter empties downstream.
        heading_zh: z.string().default(""),
        heading_en: z.string().default(""),
        body_zh: z.string().default(""),
        body_en: z.string().default(""),
        anchor_id: z.string().nullish(),
      }),
    )
    .default([]),
});

export type LlmAnalysisOutput = z.infer<typeof AnalysisResponseSchema>;
export type LlmSectionsOutput = z.infer<typeof SectionsResponseSchema>;

export interface LlmCallResult<T> {
  provider: LlmProvider;
  output: T;
  latencyMs: number;
  totalTokens: number | null;
  /** When the provider is a reasoning model, the length of the reasoning chain.
   *  Useful for telemetry (V4-Pro spends most tokens here). */
  reasoningChars: number;
}

/* ============================================================
 * Prompts
 * ============================================================ */

const ANALYSIS_SYSTEM_PROMPT = `你是一名有 10 年经验的双语技术编辑，给精品技术周刊 **Glean / 拾遗** 做内容选品与加工。这一轮的任务是产出 **编辑卡片字段**（标题/摘要/要点/标签/评分/术语/线索），不生成 sections。最终输出必须是英文 key 的 JSON 对象，下面用中文讲清楚你要做什么。

============================================================
# 1. 读者画像与品味基线
============================================================

**Glean 的读者**：一线系统 / 数据 / 工具 / 设计工程师。他们：
- 时间稀缺，每条 pick 只给 30 秒判断"值不值得花 12 分钟读"
- 品味挑剔，最讨厌：标题党、AI 概括的 AI 总结、品牌喊话、装作"洞察"的空话、把名词堆叠当深度
- 在意可验证：数字、代码、配置、真实失败案例
- 喜欢克制：作者承认 trade-off、列 caveat、不喊"颠覆"

**真正的好 pick**：
- 作者是一线实操者（不是 PR、不是 AI、不是写公关稿的产品经理）
- 含具体数字 / 代码 / 配置 / 真实失败教训
- 提出新观点 或 给出可证伪的论断
- 行文克制：不喊"重磅"、"震撼"、"颠覆"、"未来已来"

**不该精选的内容**：
- 品牌发布稿包装成技术文（GA 公告、Launch 文、"重磅推出"）
- AI 二次拼贴的 listicle / SEO 内容农场
- 全是抽象名词、零具体例子（"可扩展性"、"高性能"、"赋能"、"打通")
- 大量 hyped 词："未来"、"革命"、"范式"、"重塑"、"reimagine"

============================================================
# 2. 你最常见的 5 个失败模式（输出前必须自检）
============================================================

每次都先在脑内问自己：我是否犯了下面任何一条？

1. **bullets 写成 summary 的复述** —— bullets 应是「新论断 / 具体证据」，不是摘要的浓缩。
2. **summary 用翻译腔** —— "X 的可扩展性的提升" / "通过 Y 的能力来" / "在 Z 方面的体验感"。
3. **软文不打高 bias 分** —— 被表面"技术细节"蒙骗，给 Launch 公告打 0.1 bias。
4. **译文一侧不像母语** —— 把英文重句结构直接搬到中文（"我们也将提供...的能力"），或反过来把中文意合句变成生硬英文。
5. **title 是逐字直译** —— title_zh 不能是 title_en 的机械翻译，要做"编辑级标题"。

============================================================
# 3. 思考流程（按这个顺序在脑内走一遍）
============================================================

**Step 1 · 识别 detected_lang**
- 看 body 主体语种 → 决定哪一侧是原文。

**Step 2 · 估读者意图与作者意图**
- 这文章给谁看？语气应该多深 / 多浅？
- 作者是真技术分享，还是 PR / launch / hype？

**Step 3 · bias 检测**（决定 bias 子分 + 全篇基调）
- 0.0：一线工程师事后复盘，明确写出失败与 trade-off
- 0.2：厂商发布稿但带了真技术细节 + 数字
- 0.5：产品 Launch / GA 公告，约 70% 公关 + 30% 技术
- 0.8：AI 二次拼贴的 listicle、SEO 软文
- 1.0：纯品牌喊话、纯营销文、无技术含量

**Step 4 · 七维评分**：novelty / depth / evidence / effort / audience_fit / utility / bias。
- 最终 score ≈ (前 6 维均值) − 0.5 × bias（±0.1）。bias 越高总分越低。
- score < 0.3：列表水文、PR、AI 二次拼贴、付费墙 stub
- score 0.7-0.85：扎实技术报告，有数据有代码
- score ≥ 0.9：罕见。一线第一手报告，带新数据 / 新设计 / 新论断

**Step 5 · 术语扫描**：最多 5 个 glossary 条目，记住是"本文语境下的具体用法"，不是字典义。

**Step 6 · 草拟 → 自检（§ 9）→ 输出**。

============================================================
# 4. JSON 输出 schema
============================================================

只输出下面这个 JSON 对象。不允许任何前后文字、markdown 围栏、推理链。必须能被 \`JSON.parse(content)\` 直接解析。

{
  "title_zh": "≤ 60 个中文字符，编辑级标题（不是逐字直译）",
  "title_en": "≤ 70 个英文字符",
  "summary_zh": "150-400 个中文字符，自然中文，含核心论点 + 关键证据 + 适用读者",
  "summary_en": "80-200 个英文词",
  "bullets": [ { "zh": "8-20 中文字符", "en": "3-10 个英文词" } ],
  "tags": ["<slug>", ...],
  "category": "infra" | "data" | "code",
  "score": 0.0-1.0,
  "subscores": {
    "novelty": 0.0-1.0,
    "depth": 0.0-1.0,
    "evidence": 0.0-1.0,
    "effort": 0.0-1.0,
    "audience_fit": 0.0-1.0,
    "utility": 0.0-1.0,
    "bias": 0.0-1.0
  },
  "glossary": [ { "en": "term", "zh": "译名", "meaning": "本文语境下的用法（不是字典义）", "anchor": "可选锚点" } ],
  "next_hints": ["<topical pointer or tag slug>", ...],
  "detected_lang": "zh" | "en" | "other"
}

**注意**：本轮不输出 sections —— 那是下一轮的工作。不要把 body 内容塞到任何字段里。

============================================================
# 5. 字段职责严格区分（避免重复）
============================================================

| 字段 | 职责 | 通过测试 |
|---|---|---|
| **summary** | 整体摘要 | 读完不读正文也基本懂 |
| **bullets** | 论断 / 具体证据 punchline | 列首页能"勾"住手指 |

**自检**：如果 bullet 1 跟 summary 第一句长得几乎一样 → 你犯了失败模式 #1，必须重写。

============================================================
# 6. 翻译规范（summary / bullets / title 双语对照）
============================================================

**双向翻译方向（由 detected_lang 决定）**：
- detected_lang = "en" → \`*_en\` 一侧贴近原文，\`*_zh\` 一侧自然中文
- detected_lang = "zh" → \`*_zh\` 一侧贴近原文，\`*_en\` 一侧自然英文
- 译文那一侧必须**自然、地道**，不是单词级直译

**保留英文（不翻译）**：
- 产品名：Durable Objects / Cloudflare Workers / DeepSeek-V4-Pro / Kubernetes / Redis
- 配置 / 命令 / 文件名：\`replicas = "global"\`、\`wrangler.toml\`、\`docker-compose up\`
- 已被中文工程师广泛接受的英文术语：API / SDK / CDN / DDoS / TLS / HTTP / token / latency / throughput

**禁用翻译腔**（出现就重写）：
- 抽象名词链：「...的响应能力」「...的可扩展性」「...的体验感」「...的可观测性」—— 这类以 性 / 化 / 度 / 感 / 力 收尾的抽象名词，凡是不能转成具体中文动作的全部禁用
- 长定语前置：「为系统、工具、设计工程师设计的应用」→ 改写「面向系统/工具/设计工程师的应用」
- 被动语态搬运：「被设计来支持 X」→ 改写「为 X 而设计」
- "通过 X 的能力" / "在 Y 方面" / "针对 Z 进行"

============================================================
# 7. Tags & Category
============================================================

**category 三选一**：
- "infra"：基础设施、CDN、Edge、网络、操作系统、容器
- "data"：数据库、数据管线、存储格式、查询引擎
- "code"：编程语言、框架、工具链、应用层

**tags（1-3 个）**：
- 只能从提供的 taxonomy slug 里选，不要自创
- 选 1 个 category-aligned 的 slug（如 "edge" / "database" / "framework"）
- 可再选 1-2 个 cross-cutting（如 "performance" / "agents" / "ai"）

============================================================
# 8. 字段质量对照（成功 vs 失败示例）
============================================================

### summary_zh

❌ "本文讨论了 Durable Objects 跨区域副本的新特性"（空话，没信息）
✅ "Cloudflare 把 DO 的强一致性扩展到多区域副本，写延迟保持在 100ms 以内，读路径自动落到 freshness 窗口（默认 50ms）内最近的副本。配置只需 wrangler.toml 加一行 replicas = "global"，零代码改动。适用：多区域有状态服务。"

### bullets[].zh

❌ "跨区域副本"（抽象名词）
❌ "Durable Objects 上线了新功能"（没信息）
✅ "leader region 按对象可配，零代码迁移"
✅ "freshness 窗口（默认 50ms）调成 0 = 强一致"

### bias 评分示例

- Cloudflare 工程师写的内部 18 个月测试 + 数据 → **bias 0.15**（厂商但内容硬核）
- "5 Best Practices for X" 列表文 → **bias 0.7**（SEO 倾向）
- 个人博客记录从 N+1 到 SELECT 优化的真实经历 → **bias 0.0**
- "AI 改变了软件开发的范式" 之类的概念文 → **bias 0.85**

============================================================
# 9. 输出前自检 Checklist（必须走一遍）
============================================================

输出 JSON 之前，逐条问自己：

- [ ] **检 1**：detected_lang 是否与 body 的主体语种一致？
- [ ] **检 2**：每个 bullet 是否含具体动词 / 数字 / 配置 / 代码片段？（不能是抽象名词堆叠）
- [ ] **检 3**：bullet[i] 是否只是 summary 的复述？是 → 改写
- [ ] **检 4**：译文一侧读起来像母语吗？翻译腔 → 重写
- [ ] **检 5**：bias 评分是否反映了实际内容调性？（PR 文别打 0.1）
- [ ] **检 6**：score ≈ (前 6 维均值) − 0.5 × bias？

============================================================
# 10. 编辑克制
============================================================

**不要**写「为什么重要」「这意味着什么」这类价值判断（那是人工 editor_note 字段）。保持事实性、结构化。

**不要**在 summary / bullets 里加 emoji、惊叹号、"竟然" / "震撼" / "颠覆" 这类情绪词。

============================================================
# 11. 输出纪律
============================================================

- **只输出 JSON**。无前后文字、无 markdown 围栏 \`\`\`、无注释、无尾随逗号、无 \`undefined\` / \`NaN\` / \`Infinity\`
- 不要把推理链 / chain-of-thought 写进 content
- 不要 Unicode 制表符 / 边框字符
- JSON 字段 key 保持英文（schema 不变，下游解析依赖）
- **本轮不要输出 sections 字段**——多余的字段会被丢弃，浪费 token。`;

const SECTIONS_SYSTEM_PROMPT = `你是一名有 10 年经验的双语技术编辑，给精品技术周刊 **Glean / 拾遗** 做文章正文加工。

这一轮的任务**只有一个**：把输入的文章原文切成结构化的 sections（双语段落），每段保留原文 + 自然译文。**不要输出标题、摘要、bullets、tags、评分等字段** —— 那些已经在前一轮生成好了。

最终输出必须是英文 key 的 JSON 对象，能被 \`JSON.parse(content)\` 直接解析。

============================================================
# 1. JSON 输出 schema
============================================================

{
  "sections": [
    {
      "heading_zh": "6-20 个中文字符，命名该段的具体思想",
      "heading_en": "3-10 个英文词，naming the paragraph's idea",
      "body_en": "section 内容的英文版本",
      "body_zh": "section 内容的中文版本",
      "anchor_id": "可选：a1/a2/..."
    }
  ]
}

============================================================
# 2. Sections 切分规则
============================================================

切分单位：**一个完整思想单元 = 一个 section**（逻辑段落，不是物理段落）。绝不机械"一段一 section"。

**数量软上限**（按文章 body 总字符 / 词数估算）：
- 短文（< 800 字符 / < 600 词）：3-6 sections
- 中文（800-2500 字符 / 600-1800 词）：6-12 sections
- 长文（2500-8000 字符 / 1800-5000 词）：12-25 sections
- 超长（万字以上）：可超 25，按自然思想单元切

**合并规则**：
- 连续短段（每段 < 50 字符 / < 30 词）讲同一论点 → 合进一个 section
- 过渡段（"另一方面"、"however"、"接下来"开头的衔接句）→ 并入相邻论点段，绝不单独成段
- 引述 + 紧随的解释（"X 说:..." + 后文）→ 一个 section

**拆分规则**：
- 单段含 ≥ 3 个并列要点（"三类工作负载：A... B... C..."）→ 拆成 3 个 section
- 单段同时讲两个独立论点（用 "另一方面" / "however" 切换）→ 拆开

**特殊情形**：
- **代码块**：跟随讲解它的论点 section，不独立成段。在 body 里用原文 markdown code fence 保留。
- **图片段**：独立成 section，body_en/body_zh 就是 \`![alt](url)\` 本身。
- **列表项**：补充说明 → 合到引出列表的 section；每项是独立论点 → 拆开。

**红线（不可破）**：
- **不许漏关键信息**。每一个核心论点都必须有对应 section。
- heading 命名"这段的具体思想"，不是 "Introduction" / "结论" / "Background" 这种泛标签。

============================================================
# 3. body 保真规则
============================================================

**双向翻译方向（由输入的 detected_lang 决定）**：
- detected_lang = "en" → body_en 是原文（逐句保留），body_zh 是中文译文
- detected_lang = "zh" → body_zh 是原文（逐句保留），body_en 是英文译文
- 译文那一侧必须**自然、地道**，不是单词级直译

**保留英文（不翻译）**：
- 产品名：Durable Objects / Cloudflare Workers / DeepSeek-V4-Pro / Kubernetes / Redis
- 配置 / 命令 / 文件名：\`replicas = "global"\`、\`wrangler.toml\`、\`docker-compose up\`
- 已被中文工程师广泛接受的英文术语：API / SDK / CDN / DDoS / TLS / HTTP / token / latency / throughput
- 行内代码：所有 \`code\` 包裹的片段

**行业术语首次出现**：可用「中文/英文」并列（如「副本 / replica」），第二次出现起只用中文。

**禁用翻译腔**（出现就重写）：
- 抽象名词链：「...的响应能力」「...的可扩展性」「...的体验感」—— 凡是不能转成具体中文动作的全部禁用
- 长定语前置：「为系统、工具、设计工程师设计的应用」→ 改写「面向系统/工具/设计工程师的应用」
- 被动语态搬运：「被设计来支持 X」→ 改写「为 X 而设计」
- "通过 X 的能力" / "在 Y 方面" / "针对 Z 进行"

**body 长度**：原文那一侧逐句保留，译文那一侧用母语级表达，任一侧不限长度。但避免**重复同一信息两次**——只复述要点不算 section，必须含原文意思的完整覆盖。

**图片保真**：原段含 \`![alt](https://...)\`，body_en 和 body_zh 对应位置都必须原样保留这段 markdown，URL 一字不动；body_zh 可意译 alt 文字，URL 不可动。

**anchor_id 可选**。仅当该 section 含尖锐主张、关键数字、明确 caveat —— 编辑会想挂注的地方 —— 才写 a1/a2/...。

============================================================
# 4. heading 质量对照
============================================================

### heading_zh

❌ "引言" / "介绍" / "总结" / "结论" / "背景"（除非真是结构性章节）
❌ "新特性介绍"（泛）
✅ "leader 区域可配"
✅ "freshness 窗口的 CAP 旋钮"

============================================================
# 5. 输出前自检 Checklist
============================================================

- [ ] **检 1**：sections 数量是否匹配文章信息密度？（参照 § 2 软上限）
- [ ] **检 2**：每个 heading 是否命名了"具体思想"？（不是 "Introduction" / "Conclusion"）
- [ ] **检 3**：原文每个核心论点段是否都有对应 section？信息丢失是最严重失败
- [ ] **检 4**：原文里的每个 \`![alt](url)\` 是否在 body_en 和 body_zh 同位置都保留了 URL？
- [ ] **检 5**：译文一侧读起来像母语吗？翻译腔 → 重写

============================================================
# 6. 输出纪律
============================================================

- **只输出 JSON**。无前后文字、无 markdown 围栏 \`\`\`、无注释、无尾随逗号
- 不要把推理链 / chain-of-thought 写进 content
- 不要 Unicode 制表符 / 边框字符
- JSON 字段 key 保持英文
- **不要输出 sections 之外的字段**——title/summary/bullets/tags/score 都不属于本轮，会被忽略`;

/* ============================================================
 * Budget
 * ============================================================ */

// V4-Pro is a reasoning model: 3-7K reasoning tokens + 8-15K output tokens
// on a long article = 2-4 minutes typical. 2 minutes was clipping real
// responses mid-stream. CF Queue Consumers allow 15 minutes so we give
// V4-Pro real headroom on stream timeouts.
export interface LlmCallBudget {
  streamTimeoutMs: number;
  chunkIdleMs: number;
  bodyCap: number;
  maxTokens: number;
}

function isReasoningModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("v4-pro") || lower.includes("reasoner");
}

export function getLlmCallBudget(model: string, phase: LlmPhase = "analysis"): LlmCallBudget {
  const reasoning = isReasoningModel(model);
  // Sections is the big-output phase. Analysis is much smaller (no body
  // repeats), so it gets a tighter token cap and faster timeouts.
  const isSections = phase === "sections";
  return {
    // Sections runs in its own worker invocation (see processLlm), so it has a
    // full 15-min ceiling — but cap the stream at 13min to leave ~2min for
    // cleanup + the failure DB-write before the platform evicts the worker.
    streamTimeoutMs: reasoning ? (isSections ? 780_000 : 420_000) : 240_000,
    chunkIdleMs: reasoning ? 180_000 : 60_000,
    bodyCap: 120_000,
    // DeepSeek V4-Pro/Flash advertised max output is 384K tokens, so these
    // numbers are well within provider limits. Analysis output is small
    // (title/summary/bullets/score), 12K is plenty. Sections output is bulk
    // bilingual body — 32K gives ~60K chars of headroom, enough for the soft
    // cap of 25 sections * ~1500 chars even on very long articles.
    maxTokens: isSections ? 32_000 : 12_000,
  };
}

/* ============================================================
 * Public API
 * ============================================================ */

export interface CallLlmArgs {
  title: string;
  body: string;
  /** Override the model for this call. When set, fallback retries are
   *  skipped (caller picked this model on purpose). */
  modelOverride?: string;
  /** Submission ID — propagated into R2 dump key on parse failure. */
  submissionId?: string;
  sourceHost?: string;
  submitterNote?: string;
  submittedDate?: string;   // ISO YYYY-MM-DD
}

export interface CallLlmAnalysisArgs extends CallLlmArgs {
  /** Available tag slugs the model is allowed to pick from. */
  taxonomy: string[];
}

export interface CallLlmSectionsArgs extends CallLlmArgs {
  /** Carried from the analysis call so the model knows which side of body
   *  is the original (preserved) and which side is translated. */
  detectedLang?: "zh" | "en" | "other";
}

/**
 * Phase 1: analysis. Generates the editorial card — title/summary/bullets/
 * tags/score/glossary/next_hints. Small output; flips submission → 'ready'
 * when it succeeds.
 */
export async function callLlmAnalysis(
  env: LlmEnv,
  args: CallLlmAnalysisArgs,
): Promise<LlmCallResult<LlmAnalysisOutput>> {
  return callWithFallback(env, args, {
    phase: "analysis",
    schema: AnalysisResponseSchema,
    systemPrompt: ANALYSIS_SYSTEM_PROMPT,
    buildMessage: () =>
      buildAnalysisUserMessage({
        title: args.title,
        body: args.body,
        taxonomy: args.taxonomy.join(", "),
        sourceHost: args.sourceHost,
        submitterNote: args.submitterNote,
        submittedDate: args.submittedDate,
      }),
  });
}

/**
 * Phase 2: sections. Splits the article body into bilingual section units.
 * Bigger output; runs after analysis. A failure here does NOT downgrade
 * the submission from 'ready' — admin can retry sections separately.
 */
export async function callLlmSections(
  env: LlmEnv,
  args: CallLlmSectionsArgs,
): Promise<LlmCallResult<LlmSectionsOutput>> {
  const result = await callWithFallback(env, args, {
    phase: "sections",
    schema: SectionsResponseSchema,
    systemPrompt: SECTIONS_SYSTEM_PROMPT,
    buildMessage: () =>
      buildSectionsUserMessage({
        title: args.title,
        body: args.body,
        detectedLang: args.detectedLang,
      }),
  });
  // Drop sections the LLM left empty (truncation, schema slip). Better to
  // keep 12 good sections than reject all 14 because one came back blank.
  result.output.sections = result.output.sections.filter(
    (s) =>
      (s.body_en?.trim() || s.body_zh?.trim()) &&
      (s.heading_en?.trim() || s.heading_zh?.trim()),
  );
  return result;
}

/* ============================================================
 * Internal — shared streaming + retry plumbing
 * ============================================================ */

interface PhaseConfig<S extends z.ZodTypeAny> {
  phase: LlmPhase;
  schema: S;
  systemPrompt: string;
  buildMessage: () => string;
}

/**
 * Top-level wrapper. Tries once; on transient failures (429, 5xx, timeout,
 * fetch error) AND if `LLM_FALLBACK_MODEL` is set AND the caller did not
 * pass `modelOverride`, retries once with the fallback model. Any other
 * error (schema, auth, malformed) propagates immediately.
 */
async function callWithFallback<S extends z.ZodTypeAny>(
  env: LlmEnv,
  args: CallLlmArgs,
  cfg: PhaseConfig<S>,
): Promise<LlmCallResult<z.infer<S>>> {
  try {
    return await callOnce(env, args, cfg, args.modelOverride);
  } catch (err) {
    const e = err as Error;
    if (
      env.LLM_FALLBACK_MODEL &&
      !args.modelOverride &&
      isTransientError(e)
    ) {
      console.warn(
        `LLM ${cfg.phase} primary failed (${e.message.slice(0, 120)}); falling back to ${env.LLM_FALLBACK_MODEL}`,
      );
      return await callOnce(env, args, cfg, env.LLM_FALLBACK_MODEL);
    }
    throw err;
  }
}

function isTransientError(err: Error): boolean {
  const m = err.message;
  if (m.includes("429")) return true;            // rate limit / quota
  if (m.match(/\s5\d\d\b/) || m.includes(" 500") || m.includes(" 502") || m.includes(" 503") || m.includes(" 504")) return true;
  if (m.toLowerCase().includes("timeout")) return true;
  if (m.toLowerCase().includes("abort")) return true;
  if (m.toLowerCase().includes("stream idle")) return true;
  if (m.toLowerCase().includes("provider went quiet")) return true;
  if (m.toLowerCase().includes("fetch failed")) return true;
  if (m.toLowerCase().includes("connection")) return true;
  return false;
}

/**
 * Always streams. Both regular (gpt-4o-mini, DeepSeek-V3.2) and reasoning
 * (DeepSeek-V4-Pro) models accept stream:true; reasoning models only work
 * via streaming on ModelScope, so streaming is the lowest-common-denominator.
 *
 * We accumulate delta.content into the final JSON, and delta.reasoning_content
 * into a separate string so the editorial summary doesn't get polluted by
 * the chain-of-thought.
 */
async function callOnce<S extends z.ZodTypeAny>(
  env: LlmEnv,
  args: CallLlmArgs,
  cfg: PhaseConfig<S>,
  modelOverride?: string,
): Promise<LlmCallResult<z.infer<S>>> {
  const baseProvider = pickProvider(env);
  const provider: LlmProvider = modelOverride
    ? { ...baseProvider, model: modelOverride }
    : baseProvider;
  const budget = getLlmCallBudget(provider.model, cfg.phase);
  const trimmedBody = args.body.length > budget.bodyCap
    ? args.body.slice(0, budget.bodyCap) + "\n…(truncated; body exceeded " + budget.bodyCap.toLocaleString() + " chars)"
    : args.body;

  const started = Date.now();
  const ctrl = new AbortController();
  const deadlineAt = started + budget.streamTimeoutMs;
  const timer = setTimeout(() => ctrl.abort(), budget.streamTimeoutMs);

  // The cfg.buildMessage closure was built before trimming, but it reads
  // args.body. Rebuild from trimmed body to respect bodyCap.
  const userMessage = cfg.phase === "analysis"
    ? buildAnalysisUserMessage({
        title: args.title,
        body: trimmedBody,
        taxonomy: (args as CallLlmAnalysisArgs).taxonomy.join(", "),
        sourceHost: args.sourceHost,
        submitterNote: args.submitterNote,
        submittedDate: args.submittedDate,
      })
    : buildSectionsUserMessage({
        title: args.title,
        body: trimmedBody,
        detectedLang: (args as CallLlmSectionsArgs).detectedLang,
      });

  let res: Response;
  try {
    res = await fetch(provider.baseUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: provider.model,
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: budget.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: cfg.systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${provider.name} fetch failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const errText = await res.text();
    throw new Error(`${provider.name} ${res.status}: ${errText.slice(0, 300)}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new Error(`${provider.name}: empty response stream`);
  }

  let content = "";
  let reasoning = "";
  let totalTokens: number | null = null;

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        ctrl.abort();
        // Fire-and-forget: reader.cancel() can itself hang on a wedged SSE
        // stream, so don't await it or the timeout error never propagates.
        void reader.cancel(`${provider.name}: stream exceeded ${budget.streamTimeoutMs / 1000}s`).catch(() => {});
        throw new Error(`${provider.name}: stream timeout ${budget.streamTimeoutMs / 1000}s`);
      }

      const readPromise = reader.read();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleTimeout = new Promise<never>((_, reject) => {
        const idleMs = Math.min(budget.chunkIdleMs, remainingMs);
        idleTimer = setTimeout(
          () => reject(new Error(`${provider.name}: stream idle ${idleMs / 1000}s — provider went quiet`)),
          idleMs,
        );
      });
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await Promise.race([readPromise, idleTimeout]);
      } catch (err) {
        ctrl.abort();
        // Fire-and-forget (see above): awaiting cancel() on a wedged stream
        // can hang and swallow the idle-timeout error.
        void reader.cancel((err as Error).message).catch(() => {});
        throw err;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE is line-delimited. Process complete lines; leave any partial in buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith("data:")) continue;
        const payload = trimmedLine.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // ignore malformed chunk
        }
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (chunk.usage?.total_tokens != null) totalTokens = chunk.usage.total_tokens;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - started;

  if (!content.trim()) {
    throw new Error(
      `${provider.name}: empty content (reasoning chars: ${reasoning.length}) — ` +
        `model may not support response_format:json_object or stream:true`,
    );
  }

  let parsed: z.infer<S>;
  let repaired = false;
  try {
    const raw = stripFences(content);
    try {
      parsed = cfg.schema.parse(JSON.parse(raw));
    } catch (e1) {
      // LLMs sometimes emit invalid JSON escapes when preserving original
      // article text verbatim (`\$500`, `\(note\)`, raw newlines inside
      // string values, etc.). JSON.parse refuses these even though the
      // intent is obvious. Try a one-shot repair pass before giving up;
      // burning a whole V4-Pro run for a single bad backslash is wasteful.
      const msg = (e1 as Error).message || "";
      const looksFixable =
        msg.includes("Bad escaped character") ||
        msg.includes("Bad control character") ||
        msg.includes("Unexpected token") ||
        msg.includes("escape");
      if (!looksFixable) throw e1;
      const fixed = repairLlmJson(raw);
      if (fixed === raw) throw e1;
      parsed = cfg.schema.parse(JSON.parse(fixed));
      repaired = true;
    }
  } catch (err) {
    // Same prompt + truncated/malformed output → retry will fail the same
    // way. Mark NO_RETRY so the queue worker doesn't burn more tokens.
    // Best-effort dump to R2 for hand-repair / debugging.
    const parseErr = (err as Error).message;
    const dumpKey = await dumpLlmFailure(env, {
      phase: cfg.phase,
      provider: provider.name,
      submissionId: args.submissionId,
      rawContent: content,
      reasoning,
      tokens: totalTokens,
      parseError: parseErr,
    });
    throw new Error(
      `${NO_RETRY_MARKER} ${provider.name} ${cfg.phase} response did not match schema: ${parseErr}. ` +
        `Tokens: ${totalTokens ?? "?"}. Raw saved: ${dumpKey ?? "(R2 unavailable)"}. ` +
        `First 200: ${content.slice(0, 200)}`,
    );
  }
  if (repaired) {
    console.warn(
      `${provider.name} ${cfg.phase}: JSON repaired (dropped invalid escapes / fixed control chars)`,
    );
  }

  // Analysis-only defensive clamps. Sections has no numeric fields to clamp.
  if (cfg.phase === "analysis") {
    const a = parsed as unknown as LlmAnalysisOutput;
    // Use `??` for the missing-field fallback, not `||` — `Number(0) || 0.5`
    // would silently bump a legitimate score=0 (the prompt's "PR / list filler"
    // floor) to 0.5 and break the lowest-quality signal.
    const raw = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0.5;
    a.score = Math.max(0, Math.min(1, raw));
    if (!["infra", "data", "code"].includes(a.category)) a.category = "code";
  }

  return {
    reasoningChars: reasoning.length,
    provider,
    output: parsed,
    latencyMs,
    totalTokens,
  };
}

function stripFences(s: string): string {
  // Some models wrap JSON in ```json …``` despite response_format. Be lenient.
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * Best-effort repair for JSON the LLM emitted with invalid escapes or raw
 * control chars inside string values. Returns the (possibly modified) input;
 * if the caller's JSON.parse still fails after this, we give up.
 *
 * Real failure observed in production:
 *   { ..., "body_en": "Selling the video pipeline: \$500/month with clear ROI", ... }
 * → JSON.parse: Bad escaped character at position 4667
 *
 * The repair walks the string in a tiny state machine that knows when it's
 * inside a `"..."` value, and:
 *   - drops the backslash from invalid escape sequences (`\$`, `\(`, `\%`...)
 *     so the inner character stays
 *   - encodes raw control characters (real newline, tab, ...) as their
 *     JSON escape equivalents
 *
 * Valid JSON escapes (kept untouched): \" \\ \/ \b \f \n \r \t \uXXXX
 */
function repairLlmJson(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    // inside a "..." value
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    if (c === "\\") {
      const next = input[i + 1];
      if (next === undefined) {
        // trailing backslash at end of input — drop it
        continue;
      }
      if (
        next === '"' || next === "\\" || next === "/" ||
        next === "b" || next === "f" || next === "n" ||
        next === "r" || next === "t"
      ) {
        out += c + next;
        i++;
        continue;
      }
      if (next === "u") {
        // Keep \uXXXX intact (6 chars total). If fewer than 4 hex digits
        // follow, fall through to "invalid" below and drop the backslash.
        const hex = input.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += input.slice(i, i + 6);
          i += 5;
          continue;
        }
      }
      // invalid escape — drop the backslash, keep the next character
      out += next;
      i++;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      // raw control character — encode as JSON escape
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (c === "\b") out += "\\b";
      else if (c === "\f") out += "\\f";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Per-request user message for the analysis phase. Metadata (source_host,
 * submitter_note, submitted_date) helps the model score bias / novelty /
 * utility — e.g. a cloudflare.com URL flagged + "GA announcement" tone
 * strongly implies higher bias. Missing fields read as "(unknown)" so the
 * prompt structure is stable regardless of which signals are available.
 */
function buildAnalysisUserMessage(args: {
  title: string;
  body: string;
  taxonomy: string;
  sourceHost?: string;
  submitterNote?: string;
  submittedDate?: string;
}): string {
  return [
    `# Source metadata`,
    `- URL host: ${args.sourceHost ?? "(unknown)"}`,
    `- Submitted on: ${args.submittedDate ?? "(unknown)"}`,
    `- Submitter note: ${args.submitterNote?.trim() || "(none)"}`,
    ``,
    `# Available tag taxonomy (only pick from these slugs)`,
    args.taxonomy,
    ``,
    `# Article title (raw)`,
    args.title,
    ``,
    `# Article body`,
    args.body,
    ``,
    `Respond with valid JSON only. Do NOT include a "sections" field — sections are produced in a separate call.`,
  ].join("\n");
}

/**
 * Per-request user message for the sections phase. detected_lang comes from
 * the analysis phase output so the model knows which side of body is original
 * and which side needs translation.
 */
function buildSectionsUserMessage(args: {
  title: string;
  body: string;
  detectedLang?: "zh" | "en" | "other";
}): string {
  return [
    `# Article context`,
    `- detected_lang: ${args.detectedLang ?? "(unknown — infer from body)"}`,
    `- title: ${args.title}`,
    ``,
    `# Article body`,
    args.body,
    ``,
    `Respond with valid JSON only. Only output a "sections" field. Other fields will be ignored.`,
  ].join("\n");
}
