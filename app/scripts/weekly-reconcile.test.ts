import assert from "node:assert/strict";
import { reconcileLayout } from "../src/lib/weekly";

const layout = [
  { heading_zh: "a", heading_en: "a", pick_ids: ["p1", "p2"] },
  { heading_zh: "b", heading_en: "b", pick_ids: ["p4"] },
];
const r = reconcileLayout(layout, ["p1", "p2", "p3"]);
assert.deepEqual(new Set(r.linkIds), new Set(["p1", "p2", "p4"]));
assert.deepEqual(r.unlinkIds, ["p3"]);

const r2 = reconcileLayout(layout, []);
assert.deepEqual(new Set(r2.linkIds), new Set(["p1", "p2", "p4"]));
assert.deepEqual(r2.unlinkIds, []);

console.log("weekly-reconcile assertions passed");
