/** Admin: publish an album — makes it and its member picks publicly visible. */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { albums } from "~/db/schema";
import { albumById, picksForAlbum } from "~/lib/queries";
import { bustAlbum } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const album = await albumById(drizzleDb, id);
  if (!album) return new Response("not found", { status: 404 });
  if (album.draftStatus === "drafting") {
    return new Response("cannot publish: AI draft still in progress", { status: 409 });
  }
  if (!album.titleZh.trim() || !album.titleEn.trim()) {
    return new Response("cannot publish: title (zh + en) is required", { status: 422 });
  }

  await drizzleDb
    .update(albums)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(albums.id, id));

  // Bust the album routes + each member pick's article page (they were 404
  // while the album was a draft).
  const members = await picksForAlbum(drizzleDb, id);
  await bustAlbum(env.CACHE, album.slug, members.map((m) => m.slug));

  return new Response(null, { status: 303, headers: { Location: `/admin/albums` } });
};
