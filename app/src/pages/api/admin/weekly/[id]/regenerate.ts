/**
 * Admin: re-draft an existing weekly issue with the LLM.
 *
 * Async, same as generate.ts: set draft_status='drafting', enqueue a
 * `<id>|kind=weekly` message to the glean-llm queue, and 303 to the editor
 * immediately. runWeeklyDraft (in the 15-min worker) re-themes the currently
 * linked picks and writes the new title/intro/layout. The Pages SSR ~30s cap
 * means we can never await the V4-Pro stream here.
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  // Block a re-draft while one is already running, so a double-submit can't
  // race two workers onto the same row.
  if (issue.draftStatus === "drafting") {
    return new Response("draft already in progress", { status: 409 });
  }

  const linked = await drizzleDb.select({ id: picks.id }).from(picks).where(eq(picks.weeklyIssueId, id));
  if (linked.length === 0) {
    return new Response("no picks linked to this issue", { status: 422 });
  }

  await drizzleDb
    .update(weeklyIssues)
    .set({ draftStatus: "drafting", draftError: null, draftStartedAt: new Date() })
    .where(eq(weeklyIssues.id, id));

  await logEvent(env, id, "queue", "queued", {
    message: "weekly re-draft requested by admin",
    meta: { target: "glean-llm", source: "regenerate", kind: "weekly", picks: linked.length },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    proxyUrl.searchParams.set("kind", "weekly");
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`${id}|kind=weekly`);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
