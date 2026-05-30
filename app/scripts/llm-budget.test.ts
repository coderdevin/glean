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

const flashSections = getLlmCallBudget("deepseek-v4-flash", "sections");
assert.equal(flashSections.streamTimeoutMs, 240_000);
assert.equal(flashSections.chunkIdleMs, 60_000);
assert.equal(flashSections.bodyCap, 120_000);
assert.equal(flashSections.maxTokens, 32_000);

// Default phase argument should fall back to 'analysis' for back-compat.
const proDefault = getLlmCallBudget("deepseek-v4-pro");
assert.equal(proDefault.maxTokens, proAnalysis.maxTokens);

// Sections defaults to Flash for reliability; analysis keeps V4-Pro elsewhere.
assert.equal(defaultSectionsModel(), "deepseek-v4-flash");
assert.equal(defaultSectionsModel("deepseek-v4-pro"), "deepseek-v4-pro");

console.log("llm budget assertions passed");
