import type { APIRoute } from "astro";
import { READER_COOKIE, clearCookieOptions } from "~/lib/reader-auth";

export const prerender = false;

export const POST: APIRoute = (ctx) => {
  ctx.cookies.set(READER_COOKIE, "", clearCookieOptions());
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
