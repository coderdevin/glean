import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { readers } from "~/db/schema";
import { ulid } from "~/lib/ulid";
import {
  verifyLoginToken,
  signSession,
  sessionCookieOptions,
  READER_COOKIE,
} from "~/lib/reader-auth";

export const prerender = false;

function safeNext(next: string | null): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/me/notes";
}

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const url = new URL(ctx.request.url);
  const token = url.searchParams.get("token");
  const next = safeNext(url.searchParams.get("next"));
  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";

  const email = token ? await verifyLoginToken(secret, token) : null;
  if (!email) {
    return new Response(
      `<!doctype html><html lang=zh-CN><meta charset=utf-8><title>链接已失效 · Link expired</title><link rel=stylesheet href=/styles.css><body data-lang=zh><main class=container style="padding-top:96px"><h1>链接已失效 · Link expired</h1><p>登录链接 15 分钟内有效，请重新发起登录。</p><p><a href="/me" class="btn btn-primary">重新登录 →</a></p></main>`,
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const d = db(env.DB);
  const now = new Date();
  // Upsert so a double-fired magic link (email-client prefetch, double-click,
  // two tabs) can't hit the UNIQUE(email) constraint and 500. The id is only
  // used on first insert; we re-read to get the canonical id either way.
  const newId = ulid();
  await d
    .insert(readers)
    .values({ id: newId, email, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: readers.email, set: { lastSeenAt: now } });
  const rows = await d.select({ id: readers.id }).from(readers).where(eq(readers.email, email)).limit(1);
  const readerId = rows[0]?.id ?? newId;

  const session = await signSession(secret, readerId);
  ctx.cookies.set(READER_COOKIE, session, sessionCookieOptions());

  return ctx.redirect(next, 302);
};
