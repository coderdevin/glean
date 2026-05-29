import assert from "node:assert/strict";
import { lastWeekRange } from "../src/lib/weekly";

const r1 = lastWeekRange(new Date("2026-05-29T04:00:00Z"), "Asia/Shanghai");
assert.equal(r1.dateStart, "2026-05-18");
assert.equal(r1.dateEnd, "2026-05-24");

const r2 = lastWeekRange(new Date("2026-05-25T04:00:00Z"), "Asia/Shanghai");
assert.equal(r2.dateStart, "2026-05-18");
assert.equal(r2.dateEnd, "2026-05-24");

const r3 = lastWeekRange(new Date("2026-05-24T04:00:00Z"), "Asia/Shanghai");
assert.equal(r3.dateStart, "2026-05-11");
assert.equal(r3.dateEnd, "2026-05-17");

const r4 = lastWeekRange(new Date("2026-05-25T16:30:00Z"), "Asia/Shanghai");
assert.equal(r4.dateStart, "2026-05-18");
assert.equal(r4.dateEnd, "2026-05-24");

const r5 = lastWeekRange(new Date("2026-01-01T04:00:00Z"), "Asia/Shanghai");
assert.equal(r5.dateStart, "2025-12-22");
assert.equal(r5.dateEnd, "2025-12-28");

console.log("weekly-range assertions passed");
