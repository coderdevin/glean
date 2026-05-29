import assert from "node:assert/strict";
import { isStalledInFlight, STALL_WINDOW_MS } from "../src/lib/ingest";

const now = new Date("2026-05-29T12:00:00.000Z");
const justNow = new Date(now.getTime() - 60_000); // 1 min ago
const longAgo = new Date(now.getTime() - (STALL_WINDOW_MS + 60_000)); // past window

// Only in-flight states can stall.
assert.equal(isStalledInFlight("analyzing", longAgo, now), true);
assert.equal(isStalledInFlight("composing", longAgo, now), true);
assert.equal(isStalledInFlight("ready", longAgo, now), false, "ready is terminal, never reaped");
assert.equal(isStalledInFlight("published", longAgo, now), false);
assert.equal(isStalledInFlight("failed", longAgo, now), false);
assert.equal(isStalledInFlight("pending", longAgo, now), false, "pending hasn't started a worker yet");

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
