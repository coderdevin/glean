import assert from "node:assert/strict";
import {
  isStaleLlmQueueWait,
  isStalledInFlight,
  STALL_WINDOW_MS,
} from "../src/lib/ingest";

const now = new Date("2026-05-29T12:00:00.000Z");
const justNow = new Date(now.getTime() - 60_000); // 1 min ago
const longAgo = new Date(now.getTime() - (STALL_WINDOW_MS + 60_000)); // past window

// Only in-flight states can stall.
assert.equal(isStalledInFlight("analyzing", longAgo, now), true);
assert.equal(isStalledInFlight("composing", longAgo, now), true);
assert.equal(
  isStalledInFlight("analyzing", longAgo, now, STALL_WINDOW_MS, "extract", null),
  true,
  "extract worker without raw body can stall",
);
assert.equal(
  isStalledInFlight("analyzing", longAgo, now, STALL_WINDOW_MS, "extract", "raw/1.txt"),
  false,
  "extracted rows waiting in the LLM queue are not stalled worker runs",
);
assert.equal(isStalledInFlight("ready", longAgo, now), false, "ready is terminal, never reaped");
assert.equal(isStalledInFlight("published", longAgo, now), false);
assert.equal(isStalledInFlight("failed", longAgo, now), false);
assert.equal(isStalledInFlight("pending", longAgo, now), false, "pending hasn't started a worker yet");

// LLM queue wait is not a stalled worker run, but it is still watchdog-worthy
// once extract has completed and no LLM worker has started for too long.
assert.equal(
  isStaleLlmQueueWait("analyzing", "raw/1.txt", "extract", longAgo, now),
  true,
  "post-extract rows can get stranded waiting for glean-llm",
);
assert.equal(
  isStaleLlmQueueWait("pending", "raw/1.txt", "deepseek-v4-pro", longAgo, now),
  true,
  "admin re-run rows can get stranded waiting for glean-llm",
);
assert.equal(
  isStaleLlmQueueWait("pending", null, "extract", longAgo, now),
  false,
  "rows without extracted raw text are not LLM queue wait",
);
assert.equal(
  isStaleLlmQueueWait("composing", "raw/1.txt", null, longAgo, now),
  false,
  "sections worker stalls are handled by the in-flight reaper",
);
assert.equal(
  isStaleLlmQueueWait("pending", "raw/1.txt", "deepseek-v4-pro", justNow, now),
  false,
  "fresh LLM queue wait is allowed",
);

// Fresh in-flight rows are NOT stalled.
assert.equal(isStalledInFlight("composing", justNow, now), false);
assert.equal(isStalledInFlight("analyzing", justNow, now), false);

// Null start time → not reapable (can't judge).
assert.equal(isStalledInFlight("composing", null, now), false);

// Exactly at the boundary is not yet stalled (strictly greater).
const exactly = new Date(now.getTime() - STALL_WINDOW_MS);
assert.equal(isStalledInFlight("composing", exactly, now), false);

// Window is comfortably beyond the 15-min worker ceiling.
assert.ok(STALL_WINDOW_MS > 15 * 60_000, "stall window must exceed the 15-min worker ceiling");

console.log("reaper assertions passed");
