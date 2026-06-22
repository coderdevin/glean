/**
 * Admin: feedback-guided re-draft of a weekly issue ("按建议重做").
 *
 * Unlike regenerate (which re-selects picks by date range), refine KEEPS the
 * current linked picks and only re-shapes title/intro/sections, guided by the
 * prior draft + the editor's 改进方向. We persist the (possibly edited) feedback
 * to review_feedback, then enqueue `<id>|kind=weekly-refine`; runWeeklyRefine
 * (15-min worker) reads review_feedback + the current draft and revises.
 *
 * Async + 303 back to the editor immediately, same as generate/regenerate —
 * the Pages SSR ~30s cap can't hold the LLM stream.
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

  // Refine is a draft-only tool: it rewrites the same title/intro/sections the
  // public /weekly page serves (weekly has no separate publish copy), so on a
  // PUBLISHED issue it would silently push an LLM rewrite live with no
  // republish step. Block it — unpublish first to re-draft.
  if (issue.publishedAt) {
    return new Response(
      "已发布的周刊不能直接重做——请先取消发布。Unpublish before refining a published issue.",
      { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Block a re-draft while one is already running, so a double-submit can't
  // race two workers onto the same row.
  if (issue.draftStatus === "drafting") {
    return new Response("draft already in progress", { status: 409 });
  }
  // Block while a review is in flight: it's about to overwrite review_feedback
  // with the model's suggestions, which would race the feedback we're saving.
  if (issue.reviewStatus === "reviewing") {
    return new Response("review in progress — wait for it before refining", { status: 409 });
  }

  // The edited 改进方向 from the textarea; fall back to the saved review_feedback
  // (e.g. a re-submit with no edits) so a blank field doesn't wipe guidance.
  const form = await ctx.request.formData().catch(() => null);
  const raw = form?.get("feedback");
  const feedback =
    typeof raw === "string" && raw.trim() ? raw.trim() : issue.reviewFeedback ?? "";

  if (!feedback) {
    return new Response(
      "没有改进方向可用——先生成 Review 或填写改进方向。No feedback to refine with.",
      { status: 422, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Persist the feedback + flip to drafting. Picks are left untouched (this is
  // the deliberate difference from regenerate).
  await drizzleDb
    .update(weeklyIssues)
    .set({
      reviewFeedback: feedback,
      draftStatus: "drafting",
      draftError: null,
      draftStartedAt: new Date(),
    })
    .where(eq(weeklyIssues.id, id));

  await logEvent(env, id, "queue", "queued", {
    message: "weekly refine (feedback re-draft) requested by admin",
    meta: { target: "glean-llm", source: "refine", kind: "weekly-refine" },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    proxyUrl.searchParams.set("kind", "weekly-refine");
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`${id}|kind=weekly-refine`);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
