import type { APIRoute } from "astro";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client";
import { readerNotes, READER_NOTE_COLORS } from "~/db/schema";
import { readReaderSession } from "~/lib/reader-auth";

export const prerender = false;

const PatchBody = z.object({
  color: z.enum(READER_NOTE_COLORS).optional(),
  note: z.string().max(4000).nullable().optional(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** PATCH /api/reader/notes/:id — edit annotation text and/or color. */
export const PATCH: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  if (!sameOrigin(ctx.request)) return json({ ok: false, error: "bad origin" }, 403);

  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const session = await readReaderSession(ctx.request, secret);
  if (!session) return json({ ok: false }, 401);

  const id = ctx.params.id;
  if (!id) return json({ ok: false, error: "missing id" }, 400);

  let raw: unknown;
  try { raw = await ctx.request.json(); }
  catch { return json({ ok: false, error: "bad request" }, 400); }

  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) return json({ ok: false, error: "invalid patch" }, 400);

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.color !== undefined) set.color = parsed.data.color;
  if (parsed.data.note !== undefined) {
    const t = (parsed.data.note ?? "").trim();
    set.note = t ? t : null;
  }

  // Scope the write to this reader's own row — ownership is enforced here,
  // never trusted from the client.
  const res = await db(env.DB)
    .update(readerNotes)
    .set(set)
    .where(and(eq(readerNotes.id, id), eq(readerNotes.readerId, session.readerId)));

  // D1 reports affected rows; treat 0 as not-found/not-owned.
  const changed = (res as unknown as { meta?: { changes?: number } })?.meta?.changes;
  if (changed === 0) return json({ ok: false, error: "not found" }, 404);

  return json({ ok: true });
};

/** DELETE /api/reader/notes/:id — remove a highlight. */
export const DELETE: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  if (!sameOrigin(ctx.request)) return json({ ok: false, error: "bad origin" }, 403);

  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const session = await readReaderSession(ctx.request, secret);
  if (!session) return json({ ok: false }, 401);

  const id = ctx.params.id;
  if (!id) return json({ ok: false, error: "missing id" }, 400);

  await db(env.DB)
    .delete(readerNotes)
    .where(and(eq(readerNotes.id, id), eq(readerNotes.readerId, session.readerId)));

  return json({ ok: true });
};
