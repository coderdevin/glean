import assert from "node:assert/strict";
import { repairWeeklyDraft } from "../src/lib/weekly";

const allowed = ["a", "b", "c", "d"];

const out = repairWeeklyDraft(
  {
    sections: [
      { heading_zh: "推理", heading_en: "Inference", pick_ids: ["a", "zzz", "b"] },
      { heading_zh: "空的", heading_en: "Empty", pick_ids: ["nope"] },
    ],
  },
  allowed,
);
assert.equal(out.length, 2, "empty-after-cleanup section dropped, More section added");
assert.deepEqual(out[0], { heading_zh: "推理", heading_en: "Inference", pick_ids: ["a", "b"] });
assert.equal(out[1].heading_en, "More");
assert.deepEqual(out[1].pick_ids, ["c", "d"]);

const out2 = repairWeeklyDraft(
  { sections: [{ heading_zh: "全部", heading_en: "All", pick_ids: ["a", "b", "c", "d"] }] },
  allowed,
);
assert.equal(out2.length, 1);
assert.deepEqual(out2[0].pick_ids, ["a", "b", "c", "d"]);

const out3 = repairWeeklyDraft({ sections: [] }, allowed);
assert.equal(out3.length, 1);
assert.deepEqual(out3[0].pick_ids, ["a", "b", "c", "d"]);
assert.equal(out3[0].heading_en, "More");

const out4 = repairWeeklyDraft(
  { sections: [{ heading_zh: "x", heading_en: "x", pick_ids: ["a", "a", "b"] }] },
  allowed,
);
assert.deepEqual(out4[0].pick_ids, ["a", "b"]);

console.log("weekly-repair assertions passed");
