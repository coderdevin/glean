import assert from "node:assert/strict";
import { thisWeekToDate } from "../src/lib/weekly";

// thisWeekToDate: this week's Monday → today (end is today, never the future).
// Thursday 2026-05-28 (Shanghai) → Mon 2026-05-25 .. 2026-05-28.
const t1 = thisWeekToDate(new Date("2026-05-28T04:00:00Z"), "Asia/Shanghai");
assert.equal(t1.dateStart, "2026-05-25");
assert.equal(t1.dateEnd, "2026-05-28");

// On a Monday, start === end === that Monday.
const t2 = thisWeekToDate(new Date("2026-05-25T04:00:00Z"), "Asia/Shanghai");
assert.equal(t2.dateStart, "2026-05-25");
assert.equal(t2.dateEnd, "2026-05-25");

// On a Sunday, start = the preceding Monday, end = that Sunday.
const t3 = thisWeekToDate(new Date("2026-05-31T04:00:00Z"), "Asia/Shanghai");
assert.equal(t3.dateStart, "2026-05-25");
assert.equal(t3.dateEnd, "2026-05-31");

// tz crossing midnight: 2026-05-25T16:30Z = 2026-05-26 00:30 Shanghai (Tue).
const t4 = thisWeekToDate(new Date("2026-05-25T16:30:00Z"), "Asia/Shanghai");
assert.equal(t4.dateStart, "2026-05-25");
assert.equal(t4.dateEnd, "2026-05-26");

console.log("weekly-range assertions passed");
