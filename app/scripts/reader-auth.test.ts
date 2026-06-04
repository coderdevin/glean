import assert from "node:assert/strict";
import {
  normalizeEmail,
  parseCookies,
  generateOtpCode,
  signOtpChallenge,
  verifyOtpChallenge,
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

// --- generateOtpCode: 6 digits ---
{
  for (let i = 0; i < 50; i++) {
    const c = generateOtpCode();
    assert.match(c, /^[0-9]{6}$/, "always a zero-padded 6-digit code");
  }
}

// --- OTP challenge: correct code round-trips, binds the email ---
{
  const now = 1_000_000;
  const ch = await signOtpChallenge(SECRET, "Reader@Example.com", "123456", now);
  const email = await verifyOtpChallenge(SECRET, ch, "123456", now + 60_000);
  assert.equal(email, "reader@example.com");
}

// OTP: wrong code rejected
{
  const now = 1_000_000;
  const ch = await signOtpChallenge(SECRET, "a@b.com", "111111", now);
  assert.equal(await verifyOtpChallenge(SECRET, ch, "222222", now + 1000), null);
}

// OTP: expired
{
  const now = 1_000_000;
  const ch = await signOtpChallenge(SECRET, "a@b.com", "123456", now);
  assert.equal(await verifyOtpChallenge(SECRET, ch, "123456", now + 11 * 60 * 1000), null);
}

// OTP: wrong secret rejected (forged challenge)
{
  const ch = await signOtpChallenge(SECRET, "a@b.com", "123456", 1000);
  assert.equal(await verifyOtpChallenge("other-secret", ch, "123456", 2000), null);
}

// a session token must not validate as an OTP challenge (purpose check)
{
  const sess = await signSession(SECRET, "reader-id-1", 1000);
  assert.equal(await verifyOtpChallenge(SECRET, sess, "123456", 2000), null);
}

// --- session token: round-trip + expiry ---
{
  const now = 5_000_000;
  const tok = await signSession(SECRET, "reader-id-42", now);
  const ok = await verifySession(SECRET, tok, now + 200 * 24 * 60 * 60 * 1000); // 200 days later
  assert.deepEqual(ok, { readerId: "reader-id-42" });

  const expired = await verifySession(SECRET, tok, now + 366 * 24 * 60 * 60 * 1000); // > 1 year
  assert.equal(expired, null);
}

// session token: tampered token rejected
{
  const tok = await signSession(SECRET, "reader-id-1", 1000);
  const tampered = tok.slice(0, -2) + (tok.endsWith("a") ? "bb" : "aa");
  assert.equal(await verifySession(SECRET, tampered, 2000), null);
}

console.log("reader-auth token + cookie assertions passed");
