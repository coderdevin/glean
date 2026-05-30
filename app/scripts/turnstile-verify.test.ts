import assert from "node:assert/strict";
import { verifyTurnstile } from "../src/lib/turnstile";

async function run() {
  let captured: FormData | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: FormData }) => {
    captured = init.body;
    return { json: async () => ({ success: true }) } as unknown as Response;
  }) as typeof fetch;

  try {
    // A non-test secret so the local-dev bypass branch is skipped and a real
    // siteverify request is built.
    const ok = await verifyTurnstile("0xRealSecretValue", "token-123", "203.0.113.7");
    assert.equal(ok, true);
    assert.ok(captured, "fetch should have been called");
    assert.equal(captured!.get("secret"), "0xRealSecretValue");
    assert.equal(captured!.get("response"), "token-123");
    // remoteip must NOT be sent: on mobile networks (CGNAT / IPv4-IPv6 dual
    // stack) the POST IP differs from the challenge-solve IP, so passing it
    // makes Cloudflare reject otherwise-valid tokens.
    assert.equal(captured!.get("remoteip"), null);
  } finally {
    globalThis.fetch = origFetch;
  }

  console.log("turnstile verify assertions passed");
}

run();
