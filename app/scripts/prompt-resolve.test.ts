import assert from "node:assert/strict";
import { resolvePrompt } from "../src/lib/llm";

// override wins when it has real content
assert.equal(resolvePrompt("custom prompt", "DEFAULT"), "custom prompt");

// outer whitespace trimmed (textarea POSTs often add a trailing newline)
assert.equal(resolvePrompt("  custom  ", "DEFAULT"), "custom");

// empty / whitespace-only override falls back to default (safety net)
assert.equal(resolvePrompt("", "DEFAULT"), "DEFAULT");
assert.equal(resolvePrompt("   \n  ", "DEFAULT"), "DEFAULT");

// null / undefined (DB miss) falls back to default
assert.equal(resolvePrompt(null, "DEFAULT"), "DEFAULT");
assert.equal(resolvePrompt(undefined, "DEFAULT"), "DEFAULT");

console.log("# resolvePrompt assertions passed");
