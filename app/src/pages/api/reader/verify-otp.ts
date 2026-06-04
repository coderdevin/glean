import type { APIRoute } from "astro";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { readers } from "~/db/schema";
import { ulid } from "~/lib/ulid";
import { rateLimit } from "~/lib/ratelimit";
import {
  verifyOtpChallenge,
  signSession,
  sessionCookieOptions,
  READER_COOKIE,
} from "~/lib/reader-auth";

export const prerender = false;

const Body = z.object({
  challenge: z.string().min(1).max(2000),
  code: z.string().min(1).max(12),
});

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const ip = ctx.request.headers.get("cf-connecting-ip") ?? "0.0.0.0";

  // Throttle code-guessing per IP …
  const rl = await rateLimit(env.CACHE, "reader-otp", 10, 600, ip);
  if (!rl.ok) return json({ ok: false, error: "rate limit" }, 429);

  let raw: unknown;
  try { raw = await ctx.request.json(); }
  catch { return json({ ok: false, error: "bad request" }, 400); }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return json({ ok: false, error: "bad request" }, 400);

  // … and per challenge, so rotating IPs can't brute-force a single 6-digit
  // code: only ~8 guesses exist for any challenge before it's locked out, and a
  // fresh challenge needs a new (IP-limited) email send.
  const chLimit = await rateLimit(env.CACHE, "reader-otp-try", 8, 600, parsed.data.challenge);
  if (!chLimit.ok) return json({ ok: false, error: "too many attempts" }, 429);

  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const email = await verifyOtpChallenge(secret, parsed.data.challenge, parsed.data.code);
  if (!email) return json({ ok: false, error: "invalid code" }, 400);

  const d = db(env.DB);
  const now = new Date();
  // Upsert so concurrent verifies can't hit the UNIQUE(email) constraint.
  const newId = ulid();
  await d
    .insert(readers)
    .values({ id: newId, email, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: readers.email, set: { lastSeenAt: now } });
  const rows = await d.select({ id: readers.id }).from(readers).where(eq(readers.email, email)).limit(1);
  const readerId = rows[0]?.id ?? newId;

  const session = await signSession(secret, readerId);
  ctx.cookies.set(READER_COOKIE, session, sessionCookieOptions());

  return json({ ok: true, email });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
