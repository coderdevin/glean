import assert from "node:assert/strict";
import { publishFieldsFromAi } from "../src/lib/publish";
import type { Submission } from "../src/db/schema";

// publishFieldsFromAi is pure: it maps a submission's stored AI output onto the
// editorial fields the daily cron publishes with. Only ai*/editorNote*/
// submitterName are read, so a partial cast is enough to exercise it.
function sub(overrides: Partial<Submission>): Submission {
  return {
    aiTitleZh: "标题",
    aiTitleEn: "Title",
    aiSummaryZh: "摘要",
    aiSummaryEn: "Summary",
    aiBulletsJson: null,
    aiTagsJson: null,
    aiCategory: null,
    aiScore: null,
    editorNoteZh: null,
    editorNoteEn: null,
    submitterName: null,
    ...overrides,
  } as unknown as Submission;
}

// Happy path: full AI output maps through, bullets/tags parse, defaults apply.
const full = publishFieldsFromAi(
  sub({
    aiBulletsJson: JSON.stringify([{ zh: "要点", en: "point" }, { zh: "", en: "" }]),
    aiTagsJson: JSON.stringify(["edge", "performance"]),
    aiCategory: "infra",
    aiScore: 0.82,
    submitterName: "alice",
  }),
);
assert.ok(full, "full AI fields should publish");
assert.equal(full!.titleZh, "标题");
assert.equal(full!.category, "infra");
assert.equal(full!.score, 0.82);
assert.equal(full!.submitter, "alice");
// Blank bullet pair is dropped; the real one survives.
assert.deepEqual(full!.bullets, [{ zh: "要点", en: "point" }]);
assert.deepEqual(full!.tagSlugs, ["edge", "performance"]);

// Missing core copy → null (cron skips it, won't publish a half-empty pick).
assert.equal(publishFieldsFromAi(sub({ aiTitleZh: null })), null);
assert.equal(publishFieldsFromAi(sub({ aiSummaryEn: "   " })), null);

// Defaults: category falls back to "code", score to 0.5, garbage JSON → [].
const defaulted = publishFieldsFromAi(sub({ aiBulletsJson: "not json", aiTagsJson: "{}" }));
assert.ok(defaulted);
assert.equal(defaulted!.category, "code");
assert.equal(defaulted!.score, 0.5);
assert.deepEqual(defaulted!.bullets, []);
assert.deepEqual(defaulted!.tagSlugs, []);

// Non-finite score is treated as missing → 0.5 (mirrors the analysis clamp).
const nanScore = publishFieldsFromAi(sub({ aiScore: NaN }));
assert.equal(nanScore!.score, 0.5);
// A legitimate score of 0 is preserved (not bumped to 0.5).
const zeroScore = publishFieldsFromAi(sub({ aiScore: 0 }));
assert.equal(zeroScore!.score, 0);

console.log("publish-fields assertions passed");
