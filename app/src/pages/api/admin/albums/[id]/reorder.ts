/** Admin: reorder an album's members. Reads `pos_<pickId>` form fields (one per
 *  member) and writes them to position_in_album. Order change only — membership
 *  and visibility are untouched. */
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks } from "~/db/schema";
import { albumById } from "~/lib/queries";
import { bustAlbum } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);
  const album = await albumById(drizzleDb, id);
  if (!album) return new Response("not found", { status: 404 });

  const form = await ctx.request.formData().catch(() => null);
  if (form) {
    for (const [k, v] of form.entries()) {
      if (!k.startsWith("pos_") || typeof v !== "string") continue;
      const pickId = k.slice(4);
      const pos = Number.parseInt(v, 10);
      if (!Number.isFinite(pos)) continue;
      await drizzleDb
        .update(picks)
        .set({ positionInAlbum: pos })
        .where(and(eq(picks.id, pickId), eq(picks.albumId, id)));
    }
  }

  // Order-only change: bust the album pages (member visibility unchanged).
  await bustAlbum(env.CACHE, album.slug);
  return new Response(null, { status: 303, headers: { Location: `/admin/albums/${id}` } });
};
