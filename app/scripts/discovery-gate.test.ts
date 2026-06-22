// app/scripts/discovery-gate.test.ts
import assert from "node:assert/strict";
import { shouldScreenAuto, AUTO_PUBLISH_SCORE_THRESHOLD } from "../src/lib/ingest";

assert.equal(AUTO_PUBLISH_SCORE_THRESHOLD, 0.7);

// auto rows below threshold are screened
assert.equal(shouldScreenAuto("auto:hn", 0.62), true);
assert.equal(shouldScreenAuto("auto:rss:foo", 0.0), true);
// auto rows at/above threshold pass
assert.equal(shouldScreenAuto("auto:hn", 0.7), false);
assert.equal(shouldScreenAuto("auto:arxiv", 0.91), false);
// manual rows are NEVER screened, even at score 0
assert.equal(shouldScreenAuto("manual", 0.0), false);
assert.equal(shouldScreenAuto(null, 0.1), false);
assert.equal(shouldScreenAuto(undefined, 0.1), false);

console.log("discovery-gate.test.ts passed");
