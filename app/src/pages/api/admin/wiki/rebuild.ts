/**
 * Admin: rebuild the wiki index from the current published picks.
 *
 * Like weekly generation, the LLM call is too slow for the SSR wall-clock cap,
 * so we enqueue a `kind=wiki` message to glean-llm (15-min worker budget) and
 * 303 back to /admin/wiki. runWikiBuild writes a new wiki_index row, which is
 * live immediately (newest row wins). No submission id is involved — a synthetic
 * routing id is used so parseMessage's `id|tail` shape still parses.
 *
 * Dev: proxy straight to the local llm-consumer fetch handler (no queue poller).
 */
import type { APIRoute } from "astro";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;

  await logEvent(env, "wiki", "queue", "queued", {
    message: "wiki rebuild requested by admin",
    meta: { target: "glean-llm", source: "wiki-rebuild", kind: "wiki" },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("kind", "wiki");
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev wiki proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`wiki|kind=wiki`);
  }

  return new Response(null, { status: 303, headers: { Location: "/admin/wiki" } });
};
