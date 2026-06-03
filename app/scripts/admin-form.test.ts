import assert from "node:assert/strict";
import { readAdminForm } from "../src/lib/adminForm";

function formRequest(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("https://x/admin", { method: "POST", body: fd });
}

// readAdminForm gates EVERY admin write (publish/save/reject). It used to throw
// on any zod failure, which the routes surface as a bare HTTP 500. Trusted
// editor input must be accepted (truncated if huge), never rejected — otherwise
// each too-tight field cap is a fresh "publish 500s again" regression.

// Over-long bilingual content must not throw (was: summary max(1000) → 500).
{
  const longSummary = "牛".repeat(5000);
  const longBullets = "x".repeat(9000);
  const form = await readAdminForm(
    formRequest({
      title_zh: "标题",
      title_en: "Title",
      summary_zh: longSummary,
      summary_en: "ok",
      bullets_zh: longBullets,
      editor_zh: "z".repeat(2000),
      category: "ai-engineering",
      score: "0.8",
    }),
  );
  assert.ok(form.summary_zh.length > 1000, "long summary preserved, not rejected");
  assert.ok(form.bullets_zh.length > 4000, "long bullets preserved, not rejected");
  assert.equal(form.category, "ai-engineering", "free-form category kept");
  assert.equal(form.score, 0.8);
}

// Empty / malformed / out-of-range score must fall back, never throw.
{
  assert.equal((await readAdminForm(formRequest({ score: "" }))).score, 0.5);
  assert.equal((await readAdminForm(formRequest({ score: "not-a-number" }))).score, 0.5);
  const hi = await readAdminForm(formRequest({ score: "9" }));
  assert.ok(hi.score >= 0 && hi.score <= 1, "out-of-range score clamped/defaulted");
}

console.log("admin-form.test.ts ok");
