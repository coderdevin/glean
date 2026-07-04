/**
 * Admin: enqueue an AI draft of an album's bilingual title + intro. The draft
 * (V4-Pro) exceeds the ~30s Pages SSR cap, so we flip draft_status='drafting'
 * and enqueue `<id>|kind=album` to glean-llm; the album page shows the status.
 * Dev: proxy straight to the local llm-consumer /process (same as weekly).
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { albums } from "~/db/schema";
import { albumById } from "~/lib/queries";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const album = await albumById(drizzleDb, id);
  if (!album) return new Response("not found", { status: 404 });

  await drizzleDb
    .update(albums)
    .set({ draftStatus: "drafting", draftError: null, draftStartedAt: new Date() })
    .where(eq(albums.id, id));

  await logEvent(env, id, "queue", "queued", {
    message: "album draft requested by admin",
    meta: { target: "glean-llm", source: "album-draft", kind: "album" },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    proxyUrl.searchParams.set("kind", "album");
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`${id}|kind=album`);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/albums` } });
};
