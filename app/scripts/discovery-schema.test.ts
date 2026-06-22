// app/scripts/discovery-schema.test.ts
import assert from "node:assert/strict";
import { SUBMISSION_STATUSES } from "../src/db/schema";
import { discoverySeen, submissions } from "../src/db/schema";

// screened is a recognized status
assert.ok(SUBMISSION_STATUSES.includes("screened" as never), "screened must be in SUBMISSION_STATUSES");

// submissions has a `source` column
assert.ok("source" in submissions, "submissions table must expose a `source` column");

// discovery_seen table is defined with the expected columns
assert.ok("urlNormalized" in discoverySeen, "discovery_seen needs url_normalized PK");
assert.ok("source" in discoverySeen, "discovery_seen needs source");
assert.ok("firstSeenAt" in discoverySeen, "discovery_seen needs first_seen_at");

console.log("discovery-schema.test.ts passed");
