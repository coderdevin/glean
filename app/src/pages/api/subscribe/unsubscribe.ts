import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { subscribers } from "~/db/schema";
import { verifyToken } from "~/lib/auth";

export const prerender = false;

/**
 * One-click unsubscribe. The token is a signed `{ e: email }` minted per
 * recipient when the weekly blast goes out (also the List-Unsubscribe target).
 * GET so it works straight from the email footer link.
 */
export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const token = new URL(ctx.request.url).searchParams.get("t");
  if (!token) return new Response("missing token", { status: 400 });

  const payload = await verifyToken(env.COOKIE_SIGNING_KEY || "dev-key-please-set", token);
  if (!payload || typeof payload.e !== "string") {
    return new Response("invalid token", { status: 400 });
  }
  const email = (payload.e as string).toLowerCase();

  await db(env.DB)
    .update(subscribers)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscribers.email, email));

  return new Response(
    `<!doctype html><html lang=zh-CN><meta charset=utf-8><title>已退订 · Unsubscribed</title><link rel=stylesheet href=/styles.css><body data-lang=zh><main class=container style="padding-top:96px"><h1>已退订 · Unsubscribed</h1><p>不会再给这个邮箱发周刊了。改主意了随时可以重新订阅。</p><p><a href="/" class="btn btn-primary">回到首页 →</a></p></main>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
};
