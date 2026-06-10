import assert from "node:assert/strict";
import {
  MODELSCOPE_QUOTA_RETRIES,
  isModelScopeQuotaError,
  withModelScopeQuotaRetry,
} from "../src/lib/llm";

const QUOTA_429 = new Error(
  'modelscope 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details.","param":null,"type":"insufficient_quota"}}',
);

// --- isModelScopeQuotaError ---
assert.equal(isModelScopeQuotaError(QUOTA_429), true);
// Other 429s (rate limit without quota code) are not quota errors.
assert.equal(isModelScopeQuotaError(new Error('modelscope 429: {"error":{"code":"rate_limit"}}')), false);
// Same code from another provider stays on the existing path.
assert.equal(isModelScopeQuotaError(new Error('deepseek 429: {"error":{"code":"insufficient_quota"}}')), false);
assert.equal(isModelScopeQuotaError(new Error("modelscope 500: boom")), false);
assert.equal(isModelScopeQuotaError("not an error"), false);

// --- withModelScopeQuotaRetry --- (baseDelayMs=0 so the test runs instantly)

// Succeeds first try → fn called once.
{
  let calls = 0;
  const out = await withModelScopeQuotaRetry("test", async () => {
    calls++;
    return "ok";
  }, 0);
  assert.equal(out, "ok");
  assert.equal(calls, 1);
}

// Quota error twice, then success → 3 calls, result returned.
{
  let calls = 0;
  const out = await withModelScopeQuotaRetry("test", async () => {
    calls++;
    if (calls <= 2) throw QUOTA_429;
    return "recovered";
  }, 0);
  assert.equal(out, "recovered");
  assert.equal(calls, 3);
}

// Quota error every time → 1 initial + MODELSCOPE_QUOTA_RETRIES attempts,
// and the ORIGINAL quota error propagates (visible reject_reason in /admin).
{
  let calls = 0;
  await assert.rejects(
    withModelScopeQuotaRetry("test", async () => {
      calls++;
      throw QUOTA_429;
    }, 0),
    (err: Error) => err === QUOTA_429,
  );
  assert.equal(calls, 1 + MODELSCOPE_QUOTA_RETRIES);
}

// Non-quota error propagates immediately, no retry.
{
  let calls = 0;
  await assert.rejects(
    withModelScopeQuotaRetry("test", async () => {
      calls++;
      throw new Error("modelscope 401: bad key");
    }, 0),
    /401/,
  );
  assert.equal(calls, 1);
}

console.log("llm-quota-retry.test.ts passed");
