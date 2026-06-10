import type { APIRoute } from "astro";
import { db } from "~/db/client";
import { currentWikiIndex } from "~/lib/queries";

export const prerender = false;

// Read-only live wiki index (the LLM-synthesized map of the corpus). The wiki
// is a RETRIEVAL index, not a reader-facing page — this endpoint is its only
// public surface, powering the CLI `query` (wiki topics) and agent consumers.
// CDN-cached with a short s-maxage (same posture as /api/picks); a rebuild is
// reflected within the cache window.
const CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const wiki = await currentWikiIndex(db(env.DB));
  return new Response(JSON.stringify(wiki ?? { empty: true }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": CACHE },
  });
};
