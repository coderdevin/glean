// app/scripts/discovery-prescore.test.ts
import assert from "node:assert/strict";
import { parsePrescoreScores } from "../src/lib/llm";

// model returns {"scores":[...]} with exactly n entries
assert.deepEqual(parsePrescoreScores('{"scores":[0.8,0.1,0.55]}', 3), [0.8, 0.1, 0.55]);

// values are clamped to [0,1]
assert.deepEqual(parsePrescoreScores('{"scores":[1.5,-0.2]}', 2), [1, 0]);

// wrong length / junk → neutral 0.5 fallback for every item (fail-open: don't
// silently drop everything if the model misbehaves)
assert.deepEqual(parsePrescoreScores('{"scores":[0.9]}', 3), [0.5, 0.5, 0.5]);
assert.deepEqual(parsePrescoreScores("not json", 2), [0.5, 0.5]);

// tolerates a bare array too
assert.deepEqual(parsePrescoreScores("[0.2,0.3]", 2), [0.2, 0.3]);

console.log("discovery-prescore.test.ts passed");
