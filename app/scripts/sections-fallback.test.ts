/**
 * Regression test for the "sections phase never falls back on ModelScope free
 * quota exhaustion" bug: a batch of retries all died with `modelscope 429
 * exceeded today's quota` at the sections stage because the resolved *default*
 * sections model was passed as modelOverride, which the old fallback gate read
 * as an explicit operator choice and suppressed the DeepSeek fallback.
 */
import assert from "node:assert/strict";
import { resolveFallbackModel } from "../src/lib/llm";
import { defaultSectionsModel, sectionsFallbackModel } from "../src/lib/ingest";

const MS = { LLM_PROVIDER: "modelscope" } as never;
const DS = { LLM_PROVIDER: "deepseek" } as never;

// --- sectionsFallbackModel: cross-provider Flash fallback, auto + ModelScope only ---
// Auto path (no operator override) on a ModelScope primary → DeepSeek Flash.
assert.equal(sectionsFallbackModel(undefined, MS), "deepseek-v4-flash");
// Explicit operator model ("Re-run ModelScope") → no fallback (surface real error).
assert.equal(sectionsFallbackModel("modelscope:deepseek-ai/DeepSeek-V4-Flash", MS), undefined);
// Non-ModelScope primary → no cross-provider quota story.
assert.equal(sectionsFallbackModel(undefined, DS), undefined);
// Ops env override wins on the auto path.
assert.equal(
  sectionsFallbackModel(undefined, { LLM_PROVIDER: "modelscope", LLM_SECTIONS_FALLBACK_MODEL: "deepseek-v4-pro" } as never),
  "deepseek-v4-pro",
);

// --- the sections phase still runs Flash as its PRIMARY on the auto path ---
assert.equal(defaultSectionsModel(undefined, MS), "modelscope:deepseek-ai/DeepSeek-V4-Flash");

// --- resolveFallbackModel: the actual bug fix ---
// THE BUG: a resolved default sections model (modelOverride set) + a Flash
// fallback + suppressFallback=false → fallback IS used (previously suppressed).
assert.equal(
  resolveFallbackModel(
    { modelOverride: "modelscope:deepseek-ai/DeepSeek-V4-Flash", suppressFallback: false, fallbackModel: "deepseek-v4-flash" },
    {},
  ),
  "deepseek-v4-flash",
);
// Operator explicit re-run: suppressFallback=true → no fallback, real error shown.
assert.equal(
  resolveFallbackModel({ modelOverride: "modelscope:...", suppressFallback: true }, { LLM_FALLBACK_MODEL: "deepseek-v4-pro" }),
  null,
);
// Legacy analysis auto path: no modelOverride, no flags → LLM_FALLBACK_MODEL used.
assert.equal(resolveFallbackModel({}, { LLM_FALLBACK_MODEL: "deepseek-v4-pro" }), "deepseek-v4-pro");
// Legacy explicit override, no suppressFallback flag → suppressed (unchanged behavior).
assert.equal(resolveFallbackModel({ modelOverride: "deepseek-v4-pro" }, { LLM_FALLBACK_MODEL: "deepseek-v4-pro" }), null);
// No fallback configured anywhere → null.
assert.equal(resolveFallbackModel({}, {}), null);
// args.fallbackModel overrides env.LLM_FALLBACK_MODEL on the auto path.
assert.equal(
  resolveFallbackModel({ fallbackModel: "deepseek-v4-flash" }, { LLM_FALLBACK_MODEL: "deepseek-v4-pro" }),
  "deepseek-v4-flash",
);

console.log("sections-fallback.test.ts passed");
