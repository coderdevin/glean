/**
 * Admin: bulk-import an album's feed. Reads feed_url, dedups, enqueues fresh
 * items as `album:<slug>` submissions (ungated), and adopts album-less picks.
 * See docs/adr/0003 and lib/albums.runAlbumImport.
 *
 * NOTE: runs inline in the SSR request. For a large archive (hundreds of
 * items) this can approach the ~30s Pages wall-clock — import a small batch
 * first to validate, or split large feeds. (A queued import job is a future
 * refinement.)
 */
import type { APIRoute } from "astro";
import { db } from "~/db/client";
import { albumById } from "~/lib/queries";
import { runAlbumImport } from "~/lib/albums";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const album = await albumById(db(env.DB), id);
  if (!album) return new Response("not found", { status: 404 });
  if (!album.feedUrl) return new Response("album has no feed_url", { status: 422 });

  try {
    const result = await runAlbumImport(env, {
      id: album.id,
      slug: album.slug,
      feedUrl: album.feedUrl,
    });
    console.log("album import result", result);
  } catch (err) {
    return new Response(`import failed: ${(err as Error).message}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(null, { status: 303, headers: { Location: `/admin/albums` } });
};
