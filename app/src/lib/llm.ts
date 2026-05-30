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
import { isGithubHost } from "./extract-github";

export interface LlmEnv {
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  /** ModelScope token (ms-...). OpenAI-compatible endpoint with a generous
   *  free daily quota — preferred as the default provider when set. */
  MODELSCOPE_API_KEY?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  /** When set, automatically retry once with this model/provider spec on
   *  429 / 5xx / timeout. Skipped if the caller passed an explicit
   *  modelOverride (respect explicit intent — if admin picked a provider,
   *  don't silently switch). A cross-provider spec (e.g. "deepseek-v4-pro"
   *  while the default is ModelScope) makes this a provider fallback:
   *  ModelScope free quota exhausted → retry on paid DeepSeek. */
  LLM_FALLBACK_MODEL?: string;
  /** Optional model spec for the sections phase only (split + bilingual
   *  translation). Defaults to the active provider's Flash model — sections is
   *  mechanical big-output work that doesn't need the reasoning model the
   *  analysis phase uses. Same provider-spec syntax as LLM_FALLBACK_MODEL
   *  (e.g. "modelscope:deepseek-ai/DeepSeek-V4-Flash"). */
  LLM_SECTIONS_MODEL?: string;
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

export type LlmPhase = "analysis" | "sections" | "weekly";

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

export type ProviderName = "openai" | "deepseek" | "modelscope";

export interface LlmProvider {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Canonical per-provider endpoints + default models. ModelScope and DeepSeek
// both serve OpenAI-compatible Chat Completions, so only the base URL + key +
// model id differ. ModelScope ships DeepSeek-V4-Pro under a namespaced id.
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1/chat/completions";
const OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions";
export const MODELSCOPE_BASE_URL = "https://api-inference.modelscope.cn/v1/chat/completions";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
export const MODELSCOPE_DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Pro";

/** Build the full config for one named provider, or null if its key is unset.
 *  Each provider has a fixed canonical base URL; LLM_MODEL only overrides the
 *  default model for whichever provider is the env default (it is NOT carried
 *  across providers — a deepseek model name would 404 on ModelScope). */
export function providerConfig(env: LlmEnv, name: ProviderName): LlmProvider | null {
  switch (name) {
    case "openai":
      if (!env.OPENAI_API_KEY) return null;
      return {
        name,
        baseUrl: env.LLM_BASE_URL || OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        model: defaultModelEnv(env, name) || "gpt-4o-mini",
      };
    case "deepseek":
      if (!env.DEEPSEEK_API_KEY) return null;
      return {
        name,
        baseUrl: DEEPSEEK_BASE_URL,
        apiKey: env.DEEPSEEK_API_KEY,
        // V4-Pro is the current flagship reasoning model. `deepseek-chat` /
        // `deepseek-reasoner` are scheduled for deprecation on 2026-07-24.
        model: defaultModelEnv(env, name) || DEFAULT_DEEPSEEK_MODEL,
      };
    case "modelscope":
      if (!env.MODELSCOPE_API_KEY) return null;
      return {
        name,
        baseUrl: MODELSCOPE_BASE_URL,
        apiKey: env.MODELSCOPE_API_KEY,
        model: defaultModelEnv(env, name) || MODELSCOPE_DEFAULT_MODEL,
      };
  }
}

/** LLM_MODEL applies only to the env default provider — guards against a
 *  stale deepseek model name leaking onto ModelScope after a default switch. */
function defaultModelEnv(env: LlmEnv, name: ProviderName): string | undefined {
  return defaultProviderName(env) === name ? env.LLM_MODEL : undefined;
}

/** The effective default provider name from env (LLM_PROVIDER, else free-first
 *  auto-detect: ModelScope → DeepSeek → OpenAI). Does not validate the key. */
export function defaultProviderName(env: LlmEnv): ProviderName {
  const explicit = env.LLM_PROVIDER?.toLowerCase();
  if (explicit === "openai" || explicit === "deepseek" || explicit === "modelscope") {
    return explicit;
  }
  if (env.MODELSCOPE_API_KEY) return "modelscope";
  if (env.DEEPSEEK_API_KEY) return "deepseek";
  return "openai";
}

/** Resolve the env default provider into a usable config (or throw). */
export function pickProvider(env: LlmEnv): LlmProvider {
  const name = defaultProviderName(env);
  const cfg = providerConfig(env, name);
  if (cfg) return cfg;
  if (env.LLM_PROVIDER) {
    const key = name === "openai" ? "OPENAI_API_KEY" : name === "deepseek" ? "DEEPSEEK_API_KEY" : "MODELSCOPE_API_KEY";
    throw new Error(`LLM_PROVIDER=${env.LLM_PROVIDER} but ${key} is not set`);
  }
  throw new Error("no LLM provider configured: set MODELSCOPE_API_KEY, DEEPSEEK_API_KEY or OPENAI_API_KEY");
}

/**
 * Resolve an override "spec" (from the admin re-run buttons / queue message)
 * into a concrete provider config. The spec carries an optional provider plus
 * an optional model, letting one string select baseUrl + key + model:
 *
 *   ""  / undefined                       → env default provider
 *   "modelscope"                          → ModelScope, default model
 *   "modelscope:deepseek-ai/DeepSeek-V4-Pro" → ModelScope, explicit model
 *   "deepseek-v4-pro" / "deepseek-v4-flash"  → DeepSeek, that model
 *   "openai" / "gpt-4o-mini"              → OpenAI
 *   anything else                         → treated as a model name on the
 *                                            env default provider (back-compat)
 *
 * Throws if the resolved provider's API key is missing.
 */
export function resolveProviderSpec(env: LlmEnv, spec?: string): LlmProvider {
  const s = spec?.trim();
  if (!s) return pickProvider(env);

  const lower = s.toLowerCase();
  let name: ProviderName | null = null;
  let model: string | undefined;

  const colon = s.indexOf(":");
  const head = (colon >= 0 ? s.slice(0, colon) : s).toLowerCase();
  const tail = colon >= 0 ? s.slice(colon + 1).trim() : "";

  if (head === "modelscope") {
    name = "modelscope";
    model = tail || undefined;
  } else if (head === "deepseek" || (lower.startsWith("deepseek-") && !s.includes("/"))) {
    // The bare-name heuristic must NOT swallow namespaced ids like
    // "deepseek-ai/DeepSeek-V4-Flash" (a ModelScope model id) — those contain
    // "/" and belong to the env default provider, not the DeepSeek API.
    name = "deepseek";
    model = colon >= 0 ? tail || undefined : (lower.startsWith("deepseek-") ? s : undefined);
  } else if (head === "openai" || lower.startsWith("gpt-")) {
    name = "openai";
    model = colon >= 0 ? tail || undefined : (lower.startsWith("gpt-") ? s : undefined);
  }

  if (!name) {
    // Bare model name with no recognizable provider prefix — apply it to the
    // env default provider (preserves the old "model override" behaviour).
    const base = pickProvider(env);
    return { ...base, model: s };
  }

  const cfg = providerConfig(env, name);
  if (!cfg) {
    const key = name === "openai" ? "OPENAI_API_KEY" : name === "deepseek" ? "DEEPSEEK_API_KEY" : "MODELSCOPE_API_KEY";
    throw new Error(`provider "${name}" requested but ${key} is not set`);
  }
  return model ? { ...cfg, model } : cfg;
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

const WeeklyResponseSchema = z.object({
  title_zh: z.string(),
  title_en: z.string(),
  intro_zh: z.string(),
  intro_en: z.string(),
  sections: z
    .array(
      z.object({
        heading_zh: z.string(),
        heading_en: z.string(),
        pick_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type LlmWeeklyOutput = z.infer<typeof WeeklyResponseSchema>;

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

/* ------------------------------------------------------------------
 * GitHub repo variants. Selected (via isGithubHost on sourceHost) when the
 * submission is a github.com/<owner>/<repo> link. The extractor feeds a
 * "repo dossier" (metadata header + structure overview + README) rather than
 * an article, so these prompts tell the model to *explain the project* — not
 * to score it as journalism or translate the README verbatim.
 * ------------------------------------------------------------------ */

const GITHUB_ANALYSIS_SYSTEM_PROMPT = `你是一名有 10 年经验的双语技术编辑，给精品技术周刊 **Glean / 拾遗** 做开源项目选品与加工。这一轮的任务是产出 **编辑卡片字段**（标题/摘要/要点/标签/评分/术语/线索），不生成 sections。最终输出必须是英文 key 的 JSON 对象。

============================================================
# 0. 输入说明（重要）
============================================================

本轮输入**不是一篇文章**，而是一个 **GitHub 仓库的资料卡**：顶部是仓库元数据（描述 / 主语言 / stars / topics / license / homepage），中间是**仓库结构概览**（文件树），底部是 **README 原文**。你的判断对象是**这个开源项目本身**，不是某篇报道。

============================================================
# 1. 读者画像与品味基线
============================================================

**Glean 的读者**：一线系统 / 数据 / 工具 / 设计工程师。对开源项目他们想 30 秒判断："这个项目是干嘛的、解决了我什么问题、值不值得 star / 试用"。

**真正的好项目 pick**：
- 解决一个具体、真实的工程问题（不是 demo / toy / 课程作业）
- 有清晰的定位与边界，README 讲清楚"是什么 / 不是什么"
- 有可验证的信号：明确的用法、架构说明、真实使用场景

**评分语义（针对项目，不是文章）**：
- **novelty**：思路 / 实现是否新颖，还是又一个 me-too 轮子
- **depth**：工程深度（架构、实现复杂度、文档完备度）
- **evidence**：README 是否给出具体用法 / 配置 / 例子，而非空泛宣传
- **effort**：项目成熟度与投入（不是单文件玩具）
- **audience_fit**：是否契合一线工程师读者
- **utility**：实用价值，能直接用 / 借鉴
- **bias**：README 的**自夸 / 营销成分**。0.0 = 克制、诚实列 caveat；0.5 = 大量 "blazingly fast" "revolutionary" 但有真东西；0.85+ = 纯 hype、awesome-list、空壳 repo
- 最终 score ≈ (前 6 维均值) − 0.5 × bias（±0.1）。

============================================================
# 2. JSON 输出 schema（与文章版一致）
============================================================

{
  "title_zh": "≤ 60 个中文字符，编辑级标题，点明项目定位（不是逐字直译仓库名）",
  "title_en": "≤ 70 个英文字符",
  "summary_zh": "150-400 个中文字符：这个项目是什么 + 解决什么问题 + 核心做法 + 适用读者",
  "summary_en": "80-200 个英文词",
  "bullets": [ { "zh": "8-20 中文字符", "en": "3-10 个英文词" } ],
  "tags": ["<slug>", ...],
  "category": "infra" | "data" | "code",
  "score": 0.0-1.0,
  "subscores": { "novelty":0-1, "depth":0-1, "evidence":0-1, "effort":0-1, "audience_fit":0-1, "utility":0-1, "bias":0-1 },
  "glossary": [ { "en": "term", "zh": "译名", "meaning": "本项目语境下的用法", "anchor": "可选" } ],
  "next_hints": ["<topical pointer or tag slug>", ...],
  "detected_lang": "zh" | "en" | "other"
}

============================================================
# 3. 字段要点
============================================================

- **summary** 必须先回答"这是什么项目"，再讲"解决什么 / 怎么做"，避免复述 README 第一句的口号。
- **bullets** 是项目的具体卖点 / 能力 / 设计决策（"基于 tree-sitter 做结构解析"），不是抽象名词（"高性能"）。
- **category**：infra（基础设施/CDN/网络/容器）/ data（数据库/管线/存储/查询）/ code（语言/框架/工具链/应用层）。开发者工具、库、CLI 多归 code。
- **tags**：只能从提供的 taxonomy slug 里选，1-3 个。
- **detected_lang**：看 README 主体语种。

============================================================
# 4. 翻译规范 & 输出纪律
============================================================

- 项目名 / 命令 / 文件名 / 已通用英文术语（API/SDK/CLI/CDN…）保留英文不翻译。
- 译文一侧必须自然地道，禁翻译腔（"...的可扩展性" / "通过 X 的能力"）。
- **只输出 JSON**，英文 key，无 markdown 围栏、无注释、无尾随逗号、无推理链。
- **本轮不输出 sections 字段。**`;

const GITHUB_SECTIONS_SYSTEM_PROMPT = `你是一名有 10 年经验的双语技术编辑，给精品技术周刊 **Glean / 拾遗** 写**开源项目讲解文**。

============================================================
# 0. 本轮任务（与文章版本质不同，务必看清）
============================================================

输入是一个 **GitHub 仓库的资料卡**（元数据 + 仓库结构 + README）。你的任务**不是逐句翻译 README**，而是**综述、重新组织**出一篇**讲解这个项目的双语文章**，让一线工程师读完就懂："这是什么、解决什么问题、核心怎么做、怎么用、适合谁、有什么边界"。

你可以：基于资料卡里的信息重新组织、提炼、补充必要的解释；合并 README 里零散的内容；用结构概览推断项目的组成。你**不可以**：编造资料卡里没有的事实（版本号、benchmark 数字、不存在的功能）。拿不准的就不写。

输出必须是英文 key 的 JSON 对象，能被 \`JSON.parse(content)\` 直接解析。

============================================================
# 1. JSON 输出 schema
============================================================

{
  "sections": [
    {
      "heading_zh": "6-20 个中文字符，命名该段的具体内容",
      "heading_en": "3-10 个英文词",
      "body_en": "section 内容的英文版本",
      "body_zh": "section 内容的中文版本",
      "anchor_id": "可选：a1/a2/..."
    }
  ]
}

============================================================
# 2. 文章骨架（按需取舍，不要硬凑空段）
============================================================

建议章节顺序（每个思想单元一段，不机械对应）：
1. **项目定位** —— 一句话讲清它是什么、给谁用。
2. **解决的问题 / 动机** —— 为什么需要它，原来的痛点是什么。
3. **核心能力 / 设计** —— 它做了哪几件关键的事，关键设计决策。
4. **架构 / 工作原理** —— 怎么跑起来的，主要组件如何配合（可借助仓库结构概览）。
5. **上手用法** —— 安装 / 核心命令 / 最小使用例。命令与代码用 markdown code fence \`\`\` 原样保留。
6. **适用场景与边界 / caveat** —— 什么时候适合用、什么时候不适合、已知限制。

数量：一般 4-8 段。信息少的小项目 3-5 段，文档丰富的大项目可到 8-12 段。**绝不为凑数写空话段**。

============================================================
# 3. 双语与保真规则
============================================================

- 两侧都要**自然地道**：body_zh 是地道中文，body_en 是地道英文，互为对照而非机械直译。
- detected_lang 只用于判断哪侧更贴近原始措辞；但本轮是**综述**，两侧都允许重写润色，不要求逐句对应原 README。
- **保留英文不翻译**：项目名 / 命令 / 配置 / 文件名 / 行内 \`code\` / 已通用英文术语（API/SDK/CLI/CDN/token…）。
- 行业术语首次出现可「中文 / 英文」并列，之后只用中文。
- **代码 / 命令**：用 markdown code fence 原样保留，URL 与命令一字不动。
- **图片**：资料卡 README 里的 \`![alt](url)\`，若引用了就在 body_en / body_zh 同位置原样保留，URL 不动。
- 禁翻译腔（"...的可扩展性" / "被设计来支持 X" / "通过 Y 的能力"）。

============================================================
# 4. heading 质量
============================================================

❌ "引言" / "介绍" / "总结" / "功能列表"
✅ "用知识图谱替代逐文件阅读" / "六个 agent 的分析流水线" / "一行命令生成看板"

============================================================
# 5. 输出纪律
============================================================

- **只输出 JSON**，英文 key，只含 sections 字段。无前后文字、无 markdown 围栏、无注释、无尾随逗号、无推理链。
- 不编造事实。资料卡里没有的具体数字 / 功能不要写。`;

const WEEKLY_SYSTEM_PROMPT = `你是一名有 10 年经验的双语技术编辑，给精品技术周刊 **Glean / 拾遗** 编排每周一期的合辑。

你会收到这一周已发布的若干篇 picks（每篇有 id、中英标题、中英摘要、分类）。你的任务：

1. 给这一期起一个**有主题、有编辑品味**的中英标题（title_zh / title_en）——不要泛泛的"本周技术周刊"，要能概括这一期的内容气质。
2. 写一段**导语**（intro_zh / intro_en），中文约 200 字（180–220 字）、英文约 120–150 words，串起本期主线，像一个有观点的编辑在开篇说话。
3. 把这些 picks **按主题归类**成 2–5 个章节（sections）。**不要按给定的分类（infra/data/code）分章**——要按内容主题重新组织。每个章节给一个中英小标题（heading_zh / heading_en），并按叙事顺序列出该章节的 pick_ids。
4. 每一篇 pick 必须且只能出现在一个章节里。只能使用我给你的 id，不要编造 id。

输出必须是英文 key 的 JSON 对象，符合给定 schema。`;

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
    // full 15-min ceiling — but cap the stream at 13min (reasoning) to leave
    // ~2min for cleanup + the failure DB-write before the platform evicts the
    // worker. Non-reasoning sections (Flash) is the common path now and still
    // emits bulk bilingual output on long articles, so give it 8min — well
    // past the 4min analysis budget but clear of the worker ceiling.
    streamTimeoutMs: reasoning
      ? (isSections ? 780_000 : 420_000)
      : (isSections ? 480_000 : 240_000),
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

export interface WeeklyPickInput {
  id: string;
  title_zh: string;
  title_en: string;
  summary_zh: string;
  summary_en: string;
  category: string;
}

/** Map a published pick row (camelCase DB shape) to the weekly LLM input. */
export function toWeeklyPickInput(p: {
  id: string;
  titleZh: string;
  titleEn: string;
  summaryZh: string;
  summaryEn: string;
  category: string;
}): WeeklyPickInput {
  return {
    id: p.id,
    title_zh: p.titleZh,
    title_en: p.titleEn,
    summary_zh: p.summaryZh,
    summary_en: p.summaryEn,
    category: p.category,
  };
}

export interface CallLlmWeeklyArgs extends CallLlmArgs {
  picks: WeeklyPickInput[];
  dateStart: string;
  dateEnd: string;
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
    systemPrompt: isGithubHost(args.sourceHost)
      ? GITHUB_ANALYSIS_SYSTEM_PROMPT
      : ANALYSIS_SYSTEM_PROMPT,
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
    systemPrompt: isGithubHost(args.sourceHost)
      ? GITHUB_SECTIONS_SYSTEM_PROMPT
      : SECTIONS_SYSTEM_PROMPT,
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

/**
 * Weekly issue draft: themed sections + bilingual title/intro from a week's
 * picks. Same plumbing as analysis/sections (callWithFallback, schema retry).
 * The caller MUST run repairWeeklyDraft() on the output to enforce the
 * "every pick exactly once, only known ids" invariant.
 */
export async function callLlmWeekly(
  env: LlmEnv,
  args: CallLlmWeeklyArgs,
): Promise<LlmCallResult<LlmWeeklyOutput>> {
  return callWithFallback(env, args, {
    phase: "weekly",
    schema: WeeklyResponseSchema,
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    buildMessage: () =>
      buildWeeklyUserMessage({
        picks: args.picks,
        dateStart: args.dateStart,
        dateEnd: args.dateEnd,
      }),
  });
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
    // Fallback only on the AUTO path (no explicit per-run provider/model). An
    // explicit "Re-run ModelScope" must stay on ModelScope and surface its real
    // error (e.g. a quota/rate 429) — silently serving DeepSeek would hide the
    // provider's actual state and defeat the operator's explicit choice.
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
  // `modelOverride` is a provider/model spec (see resolveProviderSpec): it can
  // switch the whole provider (ModelScope ↔ DeepSeek), not just the model name.
  const provider: LlmProvider = resolveProviderSpec(env, modelOverride);
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
    : cfg.phase === "weekly"
    ? buildWeeklyUserMessage({
        picks: (args as CallLlmWeeklyArgs).picks,
        dateStart: (args as CallLlmWeeklyArgs).dateStart,
        dateEnd: (args as CallLlmWeeklyArgs).dateEnd,
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

/**
 * Per-request user message for the weekly phase. Lists every pick published in
 * the window with its id + bilingual title/summary + category, so the model
 * can theme them into sections. The route layer repairs pick_ids afterwards.
 */
function buildWeeklyUserMessage(args: {
  picks: WeeklyPickInput[];
  dateStart: string;
  dateEnd: string;
}): string {
  const lines = args.picks.map(
    (p) =>
      `- id: ${p.id}\n  分类: ${p.category}\n  标题(zh): ${p.title_zh}\n  标题(en): ${p.title_en}\n  摘要(zh): ${p.summary_zh}\n  摘要(en): ${p.summary_en}`,
  );
  return `本期范围：${args.dateStart} → ${args.dateEnd}\n本周已发布的 picks（共 ${args.picks.length} 篇）：\n${lines.join("\n")}`;
}
