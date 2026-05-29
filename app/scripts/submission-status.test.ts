import assert from "node:assert/strict";
import {
  STATUS_META,
  isInFlight,
  isReady,
  countValidSections,
  mapLegacyStatus,
} from "../src/lib/submissionStatus";

// Labels exist for every state, bilingual.
for (const s of ["pending","analyzing","composing","ready","published","rejected","failed"] as const) {
  assert.ok(STATUS_META[s], `meta for ${s}`);
  assert.ok(STATUS_META[s].zh && STATUS_META[s].en, `labels for ${s}`);
}
assert.equal(STATUS_META.analyzing.zh, "AI 解析中");
assert.equal(STATUS_META.composing.zh, "生成正文中");
assert.equal(STATUS_META.ready.en, "Ready");

// Predicates.
assert.equal(isInFlight("analyzing"), true);
assert.equal(isInFlight("composing"), true);
assert.equal(isInFlight("pending"), true);
assert.equal(isInFlight("ready"), false);
assert.equal(isReady("ready"), true);
assert.equal(isReady("composing"), false);

// countValidSections (now lives in submissionStatus, was previously in the retired gate module).
const two = JSON.stringify([{ body_zh: "中", body_en: "en" }, { body_zh: "二", body_en: "two" }]);
assert.equal(countValidSections(two), 2);
assert.equal(countValidSections(JSON.stringify([{ body_zh: "", body_en: " " }])), 0);
assert.equal(countValidSections(null), 0);
assert.equal(countValidSections("not json"), 0);

// mapLegacyStatus: (oldStatus, oldSectionsStatus, rejectReason, sectionsCount) -> new status
assert.deepEqual(mapLegacyStatus("processing", null, null, 0), { status: "analyzing", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", "ok", null, 5), { status: "ready", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", "pending", null, 0), { status: "composing", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", "failed", null, 0), { status: "failed", failureStage: "sections" });
assert.deepEqual(mapLegacyStatus("ready", null, null, 10), { status: "ready", failureStage: null });
assert.deepEqual(mapLegacyStatus("ready", null, null, 0), { status: "failed", failureStage: "sections" });
assert.deepEqual(mapLegacyStatus("rejected", null, "llm: boom", 0), { status: "failed", failureStage: "analysis" });
assert.deepEqual(mapLegacyStatus("rejected", null, "extract: 404", 0), { status: "failed", failureStage: "extract" });
assert.deepEqual(mapLegacyStatus("rejected", null, "editor: not good", 0), { status: "rejected", failureStage: null });
assert.deepEqual(mapLegacyStatus("published", "ok", null, 5), { status: "published", failureStage: null });
assert.deepEqual(mapLegacyStatus("pending", null, null, 0), { status: "pending", failureStage: null });

console.log("submission status assertions passed");
