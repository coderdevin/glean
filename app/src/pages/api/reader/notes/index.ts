import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client";
import { readerNotes } from "~/db/schema";
import { ulid } from "~/lib/ulid";
import { readReaderSession } from "~/lib/reader-auth";
import { CreateNoteBody } from "~/lib/reader-notes-schema";

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Same-origin guard for state-changing requests (defense in depth over Lax). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // some legitimate clients omit Origin
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** GET /api/reader/notes?pickId=… — this reader's notes for one article. */
export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const session = await readReaderSession(ctx.request, secret);
  if (!session) return json({ ok: false }, 401);

  const pickId = new URL(ctx.request.url).searchParams.get("pickId");
  if (!pickId) return json({ ok: false, error: "missing pickId" }, 400);

  const rows = await db(env.DB)
    .select()
    .from(readerNotes)
    .where(and(eq(readerNotes.readerId, session.readerId), eq(readerNotes.pickId, pickId)));

  return json({
    ok: true,
    notes: rows.map((r) => ({
      id: r.id,
      sectionIndex: r.sectionIndex,
      lang: r.lang,
      exact: r.exact,
      prefix: r.prefix,
      suffix: r.suffix,
      startOffset: r.startOffset,
      color: r.color,
      note: r.note,
    })),
  });
};

/** POST /api/reader/notes — create a highlight (+ optional annotation). */
export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  if (!sameOrigin(ctx.request)) return json({ ok: false, error: "bad origin" }, 403);

  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const session = await readReaderSession(ctx.request, secret);
  if (!session) return json({ ok: false }, 401);

  let raw: unknown;
  try { raw = await ctx.request.json(); }
  catch { return json({ ok: false, error: "bad request" }, 400); }

  const parsed = CreateNoteBody.safeParse(raw);
  if (!parsed.success) return json({ ok: false, error: "invalid note" }, 400);
  const b = parsed.data;

  const id = ulid();
  const now = new Date();
  await db(env.DB).insert(readerNotes).values({
    id,
    readerId: session.readerId,
    pickId: b.pickId,
    sectionIndex: b.sectionIndex,
    lang: b.lang,
    exact: b.exact,
    prefix: b.prefix ?? null,
    suffix: b.suffix ?? null,
    startOffset: b.startOffset,
    color: b.color,
    note: b.note?.trim() ? b.note.trim() : null,
    createdAt: now,
    updatedAt: now,
  });

  return json({ ok: true, id });
};
