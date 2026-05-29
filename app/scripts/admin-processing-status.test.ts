import assert from "node:assert/strict";
import { getAdminProcessingStatus } from "../src/lib/adminProcessingStatus";

const startedAt = new Date("2026-05-28T02:00:00.000Z");
const now = new Date("2026-05-28T02:04:30.000Z");

const llm = getAdminProcessingStatus({
  status: "analyzing",
  rawR2Key: "raw/1.txt",
  processingStartedAt: startedAt,
  processingModel: "deepseek-v4-pro",
  createdAt: new Date("2026-05-27T01:00:00.000Z"),
  rawTotalChars: 118_400,
  now,
});

assert.equal(llm.stage, "llm");
assert.equal(llm.elapsedLabel, "4min");
assert.equal(llm.windowLabel, "typical 2-4min · max 12min");
assert.equal(llm.modelLabel, "V4-Pro");
assert.equal(llm.detail, "Analyzing 118,400 chars with DeepSeek V4-Pro. This page refreshes every 4s.");
assert.equal(llm.isPastWindow, false);

const oldCreatedAt = getAdminProcessingStatus({
  status: "analyzing",
  rawR2Key: "raw/1.txt",
  processingStartedAt: null,
  processingModel: null,
  createdAt: startedAt,
  rawTotalChars: null,
  now,
});
assert.equal(oldCreatedAt.elapsedLabel, "4min");

const extract = getAdminProcessingStatus({
  status: "pending",
  rawR2Key: null,
  processingStartedAt: startedAt,
  processingModel: null,
  createdAt: startedAt,
  rawTotalChars: null,
  now,
});
assert.equal(extract.stage, "extract");
assert.equal(extract.title, "Fetching source");

console.log("admin processing status assertions passed");
