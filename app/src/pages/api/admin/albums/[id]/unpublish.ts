/** Admin: unpublish an album — hides it and its member picks again. */
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

  const members = await picksForAlbum(drizzleDb, id);
  await drizzleDb.update(albums).set({ status: "draft" }).where(eq(albums.id, id));
  await bustAlbum(env.CACHE, album.slug, members.map((m) => m.slug));

  return new Response(null, { status: 303, headers: { Location: `/admin/albums` } });
};
