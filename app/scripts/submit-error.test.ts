import assert from "node:assert/strict";
import { buildSubmitError } from "../src/lib/submitError";

// Bare error, no preserved fields.
assert.equal(buildSubmitError("turnstile"), "/submit?error=turnstile");
assert.equal(buildSubmitError("rate_limit"), "/submit?error=rate_limit");

// Preserves the URL so the visitor doesn't retype it after a turnstile failure.
{
  const out = buildSubmitError("turnstile", { url: "https://blog.cloudflare.com/x/" });
  const p = new URL("https://e.com" + out).searchParams;
  assert.equal(p.get("error"), "turnstile");
  assert.equal(p.get("url"), "https://blog.cloudflare.com/x/");
}

// Preserves both url and note, encoding special chars safely.
{
  const out = buildSubmitError("rate_limit", { url: "https://x.com/a?b=1&c=2", note: "值得一读 & more" });
  const p = new URL("https://e.com" + out).searchParams;
  assert.equal(p.get("url"), "https://x.com/a?b=1&c=2");
  assert.equal(p.get("note"), "值得一读 & more");
}

// Empty / whitespace / null fields are dropped, not echoed as blanks.
{
  const out = buildSubmitError("bad_url", { url: "   ", note: null });
  assert.equal(out, "/submit?error=bad_url");
}

// Over-long values are capped.
{
  const longUrl = "https://x.com/" + "a".repeat(5000);
  const out = buildSubmitError("server", { url: longUrl });
  const p = new URL("https://e.com" + out).searchParams;
  assert.equal(p.get("url")!.length, 2048);
}
{
  const longNote = "x".repeat(900);
  const out = buildSubmitError("turnstile", { note: longNote });
  const p = new URL("https://e.com" + out).searchParams;
  assert.equal(p.get("note")!.length, 500);
}

console.log("submit error redirect assertions passed");
