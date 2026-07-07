/**
 * Admin bulk retry — re-run EVERY `failed` submission (optionally narrowed by
 * the same free-text search the list uses). STAGE-AWARE: each row resumes from
 * the stage it failed at, never redoing completed work.
 *
 *   failed at 'sections' (body already extracted, analysis already done)
 *       → re-run ONLY the sections phase (glean-llm `id|phase=sections`).
 *         No URL re-fetch, no re-analysis, card fields untouched.
 *   failed at 'analysis' (body extracted, analysis failed)
 *       → re-run the LLM stage from analysis (glean-llm `id`). No re-fetch.
 *   failed at 'extract' or no rawR2Key
 *       → full re-fetch from extract (glean-ingest). The only path that
 *         re-downloads the URL.
 *
 * Operates on the whole matching set in D1 — NOT just the rendered page.
 */
import type { APIRoute } from "astro";
import { and, or, asc, eq, like, inArray } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions, submissionEvents } from "~/db/schema";
import { ulid } from "~/lib/ulid";

export const prerender = false;

/** Safety ceiling for one click; oldest are retried first past it. */
const MAX_PER_RUN = 1000;

/** D1 caps ~100 bound variables per statement. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const form = await ctx.request.formData().catch(() => null);
  const q = (form?.get("q")?.toString() ?? "").trim();

  const searchWhere = q
    ? or(
        like(submissions.aiTitleZh, `%${q}%`),
        like(submissions.aiTitleEn, `%${q}%`),
        like(submissions.url, `%${q}%`),
        like(submissions.submitterName, `%${q}%`),
      )
    : undefined;
  const where = and(eq(submissions.status, "failed"), searchWhere);

  const drizzle = db(env.DB);
  const backTo = `/admin?status=failed${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  const rows = await drizzle
    .select({ id: submissions.id, failureStage: submissions.failureStage, rawR2Key: submissions.rawR2Key })
    .from(submissions)
    .where(where)
    .orderBy(asc(submissions.createdAt))
    .limit(MAX_PER_RUN);

  if (rows.length === 0) {
    return new Response(null, { status: 303, headers: { Location: backTo } });
  }

  // Classify each failed row by the stage it should resume from — never redo
  // a completed stage.
  const sectionsIds: string[] = []; // extracted + analyzed; only sections failed
  const analysisIds: string[] = []; // extracted; analysis failed → skip re-fetch
  const extractIds: string[] = []; // never extracted / extract failed → re-fetch
  for (const r of rows) {
    if (!r.rawR2Key) extractIds.push(r.id);
    else if (r.failureStage === "sections") sectionsIds.push(r.id);
    else analysisIds.push(r.id); // has body; re-run LLM from analysis
  }

  const now = new Date();
  const events: { id: string; submissionId: string; stage: "queue"; status: "queued"; message: string; metaJson: string; createdAt: Date }[] = [];
  const addEvents = (ids: string[], message: string, source: string) => {
    for (const id of ids) {
      events.push({
        id: ulid(),
        submissionId: id,
        stage: "queue",
        status: "queued",
        message,
        metaJson: JSON.stringify({ source }),
        createdAt: now,
      });
    }
  };

  // --- Sections-only: resume phase 2, keep extracted body + analysis intact ---
  if (sectionsIds.length > 0) {
    for (const part of chunk(sectionsIds, 90)) {
      await drizzle
        .update(submissions)
        .set({
          status: "composing",
          failureStage: null,
          aiSectionsError: null,
          rejectReason: null,
          processingStartedAt: now,
        })
        .where(inArray(submissions.id, part));
    }
    for (const part of chunk(sectionsIds, 100)) {
      await env.INGEST_LLM.sendBatch(part.map((id) => ({ body: `${id}|phase=sections` })));
    }
    addEvents(sectionsIds, "batch retry: sections-only (resume phase 2)", "batch-retry-sections");
  }

  // --- Analysis re-run: body already extracted, re-run LLM from phase 1 ---
  // (glean-llm bare id, same as the admin "re-run AI" button). No re-fetch.
  if (analysisIds.length > 0) {
    for (const part of chunk(analysisIds, 90)) {
      await drizzle
        .update(submissions)
        .set({
          status: "pending",
          processedAt: null,
          rejectReason: null,
          failureStage: null,
          aiSectionsError: null,
          processingStartedAt: now,
          processingModel: null,
        })
        .where(inArray(submissions.id, part));
    }
    for (const part of chunk(analysisIds, 100)) {
      await env.INGEST_LLM.sendBatch(part.map((id) => ({ body: id })));
    }
    addEvents(analysisIds, "batch retry: re-run LLM from analysis (body kept)", "batch-retry-analysis");
  }

  // --- Full re-fetch from extract: no usable prior work to resume from ---
  if (extractIds.length > 0) {
    for (const part of chunk(extractIds, 90)) {
      await drizzle
        .update(submissions)
        .set({
          status: "pending",
          processedAt: null,
          rejectReason: null,
          failureStage: null,
          aiSectionsError: null,
          processingStartedAt: now,
          processingModel: "extract",
          rawR2Key: null,
          extractedLang: null,
        })
        .where(inArray(submissions.id, part));
    }
    for (const part of chunk(extractIds, 100)) {
      await env.INGEST.sendBatch(part.map((id) => ({ body: id })));
    }
    addEvents(extractIds, "batch retry: full re-fetch from extract", "batch-retry-extract");
  }

  // One "re-queued" event per row (7 cols → chunk under the ~100-bind ceiling).
  // Non-fatal: the retry already happened; a lost event only dents the timeline.
  try {
    for (const part of chunk(events, 12)) {
      await drizzle.insert(submissionEvents).values(part);
    }
  } catch (err) {
    console.error("retry-failed: event log insert failed (retry still queued)", (err as Error).message);
  }

  console.log(
    `retry-failed: sections-only=${sectionsIds.length} analysis=${analysisIds.length} re-fetch=${extractIds.length}${q ? ` matching "${q}"` : ""}`,
  );
  return new Response(null, { status: 303, headers: { Location: backTo } });
};
