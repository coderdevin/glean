/**
 * Admin: generate an on-demand editorial self-review of a weekly draft.
 *
 * The LLM critiques the current draft (做得好 / 做得不好 / 改进方向). Async, same
 * as generate/regenerate: set review_status='reviewing', enqueue a
 * `<id>|kind=weekly-review` message to the glean-llm queue, and 303 back to the
 * editor immediately. runWeeklyReview (in the 15-min worker) writes
 * review_json / review_status and seeds review_feedback.
 *
 * review_status is INDEPENDENT of draft_status — running a review never touches
 * the draft, so it works on any issue that has a draft (including 'ready').
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { weeklyIssues } from "~/db/schema";
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

  // A usable draft must exist before there's anything to review.
  if (issue.draftStatus === "drafting") {
    return new Response("draft in progress — wait for it to finish", { status: 409 });
  }
  if (issue.draftStatus === "failed") {
    return new Response("draft failed — re-draft before reviewing", { status: 409 });
  }

  // Reset review state to 'reviewing' + stamp the start time so the cron
  // watchdog (reapStalledWeeklyReviews) can recover an evicted run. Allowed
  // even from a stuck 'reviewing' (re-click) — a stranded review never bricks
  // the issue, so we just re-run.
  await drizzleDb
    .update(weeklyIssues)
    .set({ reviewStatus: "reviewing", reviewError: null, reviewStartedAt: new Date() })
    .where(eq(weeklyIssues.id, id));

  await logEvent(env, id, "queue", "queued", {
    message: "weekly review requested by admin",
    meta: { target: "glean-llm", source: "review", kind: "weekly-review" },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    proxyUrl.searchParams.set("kind", "weekly-review");
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`${id}|kind=weekly-review`);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
