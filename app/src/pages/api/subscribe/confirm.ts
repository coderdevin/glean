import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { subscribers } from "~/db/schema";
import { verifyToken } from "~/lib/auth";

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const token = new URL(ctx.request.url).searchParams.get("t");
  if (!token) return new Response("missing token", { status: 400 });

  const payload = await verifyToken(env.COOKIE_SIGNING_KEY || "dev-key-please-set", token);
  if (!payload || typeof payload.e !== "string") {
    return new Response("invalid token", { status: 400 });
  }
  const email = payload.e as string;

  await db(env.DB).update(subscribers).set({
    confirmedAt: new Date(),
    confirmToken: null,
  }).where(eq(subscribers.email, email));

  return new Response(
    `<!doctype html><html lang=zh-CN><meta charset=utf-8><title>已确认 · Confirmed</title><link rel=stylesheet href=/styles.css><body data-lang=zh><main class=container style="padding-top:96px"><h1>已确认订阅 · Subscribed</h1><p>下周一早上会收到第一封。</p><p><a href="/" class="btn btn-primary">回到首页 →</a></p></main>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
};
