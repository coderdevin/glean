/**
 * Reader identity — passwordless email-OTP login + signed session cookie.
 * Built on the existing HMAC token primitives (lib/auth.ts) and reused across
 * the reader API routes and /me/* pages. Soft auth, completely separate from
 * the admin gate in middleware.ts — never touches ADMIN_EMAILS.
 *
 * Login is a 6-digit code emailed to the reader, verified in-page (no link to
 * click, no new tab). It's stateless: the server signs an opaque "challenge"
 * token holding the email + an HMAC of the code, hands it to the client, and
 * later re-derives the HMAC from the typed code to check it — no KV/DB row for
 * pending codes. The challenge carries only a hash, so it's safe client-side.
 *
 * Token shapes (HMAC-signed, see signToken):
 *   challenge: { e: <email>, p: "otp", h: <hmac(code)>, exp: <ms> } — emailed code
 *   session:   { rid: <readerId>, exp: <ms> }                        — in cookie
 *
 * Pure logic is unit-tested via scripts/reader-auth.test.ts. Cookie attributes
 * live here too so routes stay thin and the flags can't drift.
 */
import { signToken, verifyToken, hmac } from "./auth";

export const READER_COOKIE = "glean_reader";
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year (rolling)

/** Trim + lowercase so identity is canonical regardless of how it was typed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A fresh 6-digit numeric login code (zero-padded, cryptographically random). */
export function generateOtpCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** Keyed hash binding a code to an email — never reversible without the secret. */
function codeHash(secret: string, email: string, code: string): Promise<string> {
  return hmac(secret, `otp:${normalizeEmail(email)}:${code.trim()}`);
}

/**
 * Sign an opaque OTP challenge for (email, code). Safe to hand to the client:
 * it carries only the keyed hash of the code, not the code itself.
 */
export async function signOtpChallenge(
  secret: string,
  email: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return signToken(secret, {
    e: normalizeEmail(email),
    p: "otp",
    h: await codeHash(secret, email, code),
    exp: nowMs + OTP_TTL_MS,
  });
}

/**
 * Verify a typed code against a challenge. Returns the bound email on success,
 * else null (bad signature, expired, wrong purpose, or wrong code).
 */
export async function verifyOtpChallenge(
  secret: string,
  challenge: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const payload = await verifyToken(secret, challenge);
  if (!payload) return null;
  if (payload.p !== "otp") return null;
  if (typeof payload.exp !== "number" || nowMs > payload.exp) return null;
  if (typeof payload.e !== "string" || !payload.e) return null;
  if (typeof payload.h !== "string") return null;
  const expected = await codeHash(secret, payload.e, code);
  // Constant-time-ish compare via the HMAC equality of equal-length b64 strings.
  if (expected.length !== payload.h.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ payload.h.charCodeAt(i);
  if (diff !== 0) return null;
  return payload.e;
}

/** Sign a session token carrying the reader id, expiring in ~1 year (rolling). */
export function signSession(
  secret: string,
  readerId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return signToken(secret, { rid: readerId, exp: nowMs + SESSION_TTL_MS });
}

/** Verify a session token; returns { readerId } if valid and unexpired. */
export async function verifySession(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<{ readerId: string } | null> {
  const payload = await verifyToken(secret, token);
  if (!payload) return null;
  if (typeof payload.exp !== "number" || nowMs > payload.exp) return null;
  if (typeof payload.rid !== "string" || !payload.rid) return null;
  return { readerId: payload.rid };
}

/** Minimal Cookie-header parser (name → value). */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    // A malformed %-sequence in ANY unrelated cookie on the domain would make
    // decodeURIComponent throw; fall back to the raw value so one bad cookie
    // can't 500 every reader route.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Read + verify the reader session from a request's Cookie header.
 * Returns { readerId } or null. The single entry point used by every reader
 * API route and the /me/* pages — reader_id is NEVER taken from the client.
 */
export async function readReaderSession(
  request: Request,
  secret: string,
  nowMs: number = Date.now(),
): Promise<{ readerId: string } | null> {
  const token = parseCookies(request.headers.get("cookie"))[READER_COOKIE];
  if (!token) return null;
  return verifySession(secret, token, nowMs);
}

/** Astro cookie options for the session cookie. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Astro cookie options to clear the session cookie. */
export function clearCookieOptions() {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 0 };
}
