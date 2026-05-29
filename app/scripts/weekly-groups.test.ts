import assert from "node:assert/strict";
import { buildWeeklyGroups } from "../src/lib/weekly";

type P = { id: string; title: string };
const picks: P[] = [
  { id: "p1", title: "one" },
  { id: "p2", title: "two" },
  { id: "p3", title: "three" },
  { id: "p4", title: "four" },
];

// Layout order is honored; unknown ids skipped; omitted picks → trailing More.
const layout = [
  { heading_zh: "甲", heading_en: "A", pick_ids: ["p2", "zzz", "p1"] },
  { heading_zh: "乙", heading_en: "B", pick_ids: ["p4"] },
];
const groups = buildWeeklyGroups(layout, picks);
assert.equal(groups.length, 3, "two layout groups + a More group for p3");
assert.deepEqual(groups[0].picks.map((p) => p.id), ["p2", "p1"]);
assert.equal(groups[0].zh, "甲");
assert.deepEqual(groups[1].picks.map((p) => p.id), ["p4"]);
assert.equal(groups[2].en, "More");
assert.deepEqual(groups[2].picks.map((p) => p.id), ["p3"]);

// Empty layout → everything in a single More group.
const all = buildWeeklyGroups([], picks);
assert.equal(all.length, 1);
assert.deepEqual(all[0].picks.map((p) => p.id), ["p1", "p2", "p3", "p4"]);

// A section that resolves to zero known picks is dropped entirely.
const dropped = buildWeeklyGroups([{ heading_zh: "空", heading_en: "Empty", pick_ids: ["nope"] }], picks);
assert.equal(dropped[0].en, "More", "empty section dropped, leftovers become More");
assert.equal(dropped.length, 1);

console.log("weekly-groups assertions passed");
