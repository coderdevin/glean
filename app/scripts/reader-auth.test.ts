import assert from "node:assert/strict";
import {
  normalizeEmail,
  parseCookies,
  signLoginToken,
  verifyLoginToken,
  signSession,
  verifySession,
  READER_COOKIE,
} from "../src/lib/reader-auth";

const SECRET = "test-secret-key";

// --- normalizeEmail ---
assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");

// --- parseCookies ---
{
  const c = parseCookies("a=1; glean_reader=abc.def; x=y%20z");
  assert.equal(c["a"], "1");
  assert.equal(c[READER_COOKIE], "abc.def");
  assert.equal(c["x"], "y z"); // url-decoded
  assert.deepEqual(parseCookies(null), {});
}

// --- login token: round-trip ---
{
  const now = 1_000_000;
  const tok = await signLoginToken(SECRET, "Reader@Example.com", now);
  const email = await verifyLoginToken(SECRET, tok, now + 60_000); // 1 min later
  assert.equal(email, "reader@example.com");
}

// login token: expired
{
  const now = 1_000_000;
  const tok = await signLoginToken(SECRET, "a@b.com", now);
  const email = await verifyLoginToken(SECRET, tok, now + 16 * 60 * 1000); // 16 min later
  assert.equal(email, null);
}

// login token: wrong secret rejected
{
  const tok = await signLoginToken(SECRET, "a@b.com", 1000);
  assert.equal(await verifyLoginToken("other-secret", tok, 2000), null);
}

// a session token must not validate as a login token (purpose check)
{
  const sess = await signSession(SECRET, "reader-id-1", 1000);
  assert.equal(await verifyLoginToken(SECRET, sess, 2000), null);
}

// --- session token: round-trip + expiry ---
{
  const now = 5_000_000;
  const tok = await signSession(SECRET, "reader-id-42", now);
  const ok = await verifySession(SECRET, tok, now + 24 * 60 * 60 * 1000); // 1 day later
  assert.deepEqual(ok, { readerId: "reader-id-42" });

  const expired = await verifySession(SECRET, tok, now + 91 * 24 * 60 * 60 * 1000);
  assert.equal(expired, null);
}

// session token: tampered token rejected
{
  const tok = await signSession(SECRET, "reader-id-1", 1000);
  const tampered = tok.slice(0, -2) + (tok.endsWith("a") ? "bb" : "aa");
  assert.equal(await verifySession(SECRET, tampered, 2000), null);
}

console.log("reader-auth token + cookie assertions passed");
