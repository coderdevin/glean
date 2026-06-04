/**
 * Reader identity — passwordless magic-link login + signed session cookie.
 * Built on the existing HMAC token primitives (lib/auth.ts) and reused across
 * the reader API routes and /me/* pages. Soft auth, completely separate from
 * the admin gate in middleware.ts — never touches ADMIN_EMAILS.
 *
 * Token shapes (HMAC-signed, see signToken):
 *   login:   { e: <email>, p: "login", exp: <ms> }   — short-lived, emailed
 *   session: { rid: <readerId>, exp: <ms> }           — long-lived, in cookie
 *
 * Pure logic (sign/verify/normalize/parse) is unit-tested via
 * scripts/reader-auth.test.ts. Cookie attributes live here too so routes stay
 * thin and the flags can't drift.
 */
import { signToken, verifyToken } from "./auth";

export const READER_COOKIE = "glean_reader";
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Trim + lowercase so identity is canonical regardless of how it was typed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Sign a magic-link login token bound to an email, expiring in ~15 min. */
export function signLoginToken(
  secret: string,
  email: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return signToken(secret, {
    e: normalizeEmail(email),
    p: "login",
    exp: nowMs + LOGIN_TOKEN_TTL_MS,
  });
}

/** Verify a login token; returns the email if valid and unexpired, else null. */
export async function verifyLoginToken(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const payload = await verifyToken(secret, token);
  if (!payload) return null;
  if (payload.p !== "login") return null;
  if (typeof payload.exp !== "number" || nowMs > payload.exp) return null;
  if (typeof payload.e !== "string" || !payload.e) return null;
  return payload.e;
}

/** Sign a session token carrying the reader id, expiring in ~90 days. */
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
