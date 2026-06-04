import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { readers } from "~/db/schema";
import { readReaderSession } from "~/lib/reader-auth";

export const prerender = false;

/** Lightweight login-state probe for the client (no caching). */
export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const session = await readReaderSession(ctx.request, secret);
  if (!session) return json({ ok: false }, 401);

  const rows = await db(env.DB)
    .select({ email: readers.email })
    .from(readers)
    .where(eq(readers.id, session.readerId))
    .limit(1);
  if (!rows[0]) return json({ ok: false }, 401);

  return json({ ok: true, email: rows[0].email });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
