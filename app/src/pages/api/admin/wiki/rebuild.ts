/**
 * Admin: rebuild or incrementally update the wiki index from published picks.
 *
 * form: mode=full | mode=incremental (default incremental — the cheap daily
 * verb; full is the consolidation pass that restructures themes).
 *
 * Like weekly generation, the LLM call is too slow for the SSR wall-clock cap,
 * so we enqueue a `kind=wiki` message to glean-llm (15-min worker budget) and
 * 303 back to /admin/wiki. runWikiBuild writes a new wiki_index row, which is
 * live immediately (newest row wins). No submission id is involved — a synthetic
 * routing id is used so parseMessage's `id|tail` shape still parses.
 *
 * In-flight guard: a queued/started event younger than STALE_MS means a build
 * is (probably) still running — skip the enqueue so a double-click or an
 * impatient editor can't stack concurrent builds (max_concurrency=3 would
 * happily run them in parallel, last finisher wins). Past STALE_MS the worker
 * is presumed dead and a retry is allowed.
 *
 * Dev: proxy straight to the local llm-consumer fetch handler (no queue poller).
 */
import type { APIRoute } from "astro";
import { logEvent } from "~/lib/ingest";
import { db } from "~/db/client";
import { latestWikiEvent } from "~/lib/queries";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";
const STALE_MS = 8 * 60 * 1000; // mirror /admin/wiki's stuck threshold

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;

  let mode: "full" | "incremental" = "incremental";
  try {
    const fd = await ctx.request.formData();
    if (String(fd.get("mode") ?? "") === "full") mode = "full";
  } catch {
    /* no form body → default mode */
  }

  const ev = await latestWikiEvent(db(env.DB));
  const inFlight =
    (ev?.status === "queued" || ev?.status === "started") &&
    ev.created_at != null &&
    Date.now() - new Date(ev.created_at).getTime() < STALE_MS;
  if (inFlight) {
    // A build is already running; the admin page shows its live state.
    return new Response(null, { status: 303, headers: { Location: "/admin/wiki" } });
  }

  await logEvent(env, "wiki", "queue", "queued", {
    message: `wiki ${mode} rebuild requested by admin`,
    meta: { target: "glean-llm", source: "wiki-rebuild", kind: "wiki", mode },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("kind", "wiki");
    proxyUrl.searchParams.set("mode", mode);
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev wiki proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`wiki|kind=wiki&mode=${mode}`);
  }

  return new Response(null, { status: 303, headers: { Location: "/admin/wiki" } });
};
