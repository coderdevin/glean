import assert from "node:assert/strict";
import { defaultSectionsModel } from "../src/lib/ingest";
import { getLlmCallBudget } from "../src/lib/llm";

// V4-Pro (reasoning) — analysis phase
const proAnalysis = getLlmCallBudget("deepseek-v4-pro", "analysis");
assert.equal(proAnalysis.streamTimeoutMs, 420_000);
assert.equal(proAnalysis.chunkIdleMs, 180_000);
assert.equal(proAnalysis.bodyCap, 120_000);
assert.equal(proAnalysis.maxTokens, 12_000);

// V4-Pro (reasoning) — sections phase. Bigger output, longer timeout.
const proSections = getLlmCallBudget("deepseek-v4-pro", "sections");
assert.equal(proSections.streamTimeoutMs, 780_000);
assert.equal(proSections.chunkIdleMs, 180_000);
assert.equal(proSections.bodyCap, 120_000);
assert.equal(proSections.maxTokens, 32_000);

// V4-Flash (non-reasoning) — same per-phase max_tokens, faster wall clock.
const flashAnalysis = getLlmCallBudget("deepseek-v4-flash", "analysis");
assert.equal(flashAnalysis.streamTimeoutMs, 240_000);
assert.equal(flashAnalysis.chunkIdleMs, 60_000);
assert.equal(flashAnalysis.bodyCap, 120_000);
assert.equal(flashAnalysis.maxTokens, 12_000);

// Non-reasoning sections is the common path now (Flash) and still emits bulk
// bilingual output on long articles, so it gets 8min — not the 4min analysis budget.
const flashSections = getLlmCallBudget("deepseek-v4-flash", "sections");
assert.equal(flashSections.streamTimeoutMs, 480_000);
assert.equal(flashSections.chunkIdleMs, 60_000);
assert.equal(flashSections.bodyCap, 120_000);
assert.equal(flashSections.maxTokens, 32_000);

// Default phase argument should fall back to 'analysis' for back-compat.
const proDefault = getLlmCallBudget("deepseek-v4-pro");
assert.equal(proDefault.maxTokens, proAnalysis.maxTokens);

// Sections model selection (provider-aware). Precedence: explicit override >
// env.LLM_SECTIONS_MODEL > the active provider's Flash (non-reasoning) model.
const deepseekEnv = { LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "x" };
const modelscopeEnv = { LLM_PROVIDER: "modelscope", MODELSCOPE_API_KEY: "x" };
assert.equal(defaultSectionsModel(undefined, deepseekEnv), "deepseek-v4-flash");
// ModelScope ships Flash under a namespaced id; the spec is provider-qualified
// so resolveProviderSpec routes it to the ModelScope endpoint, not DeepSeek.
assert.equal(defaultSectionsModel(undefined, modelscopeEnv), "modelscope:deepseek-ai/DeepSeek-V4-Flash");
// An explicit override always wins, regardless of provider.
assert.equal(defaultSectionsModel("deepseek-v4-pro", modelscopeEnv), "deepseek-v4-pro");
// LLM_SECTIONS_MODEL overrides the per-provider default.
assert.equal(
  defaultSectionsModel(undefined, { ...modelscopeEnv, LLM_SECTIONS_MODEL: "deepseek-v4-flash" }),
  "deepseek-v4-flash",
);

console.log("llm budget assertions passed");
