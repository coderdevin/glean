/**
 * Admin bulk retry — re-run EVERY `failed` submission (optionally narrowed by
 * the same free-text search the list uses) through the full pipeline from the
 * extract stage. Same per-row action as `/api/admin/[id]/refetch`, batched:
 * status→pending, failure metadata cleared, rawR2Key nulled so the worker
 * actually refetches, then re-enqueued to glean-ingest.
 *
 * Operates on the whole matching set in D1 — NOT just the rendered page — so a
 * few-hundred-deep failed queue clears in one click.
 */
import type { APIRoute } from "astro";
import { and, or, asc, eq, like, inArray } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions, submissionEvents } from "~/db/schema";
import { ulid } from "~/lib/ulid";

export const prerender = false;

/** Safety ceiling for one click. Hundreds fit; this only guards against a
 *  pathological reset flooding the queue/subrequest budget in a single run.
 *  Beyond this the editor clicks again — oldest are retried first. */
const MAX_PER_RUN = 1000;

/** D1 caps ~100 bound variables per statement. inArray(ids) binds one each,
 *  so chunk id lists well under that. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const form = await ctx.request.formData().catch(() => null);
  const q = (form?.get("q")?.toString() ?? "").trim();

  // Mirror the list's search predicate (title zh/en, url, submitter) so
  // "retry all" retries exactly the set the editor is looking at.
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

  // Oldest-first so a truncated run drains the backlog tail, not the newest.
  const idRows = await drizzle
    .select({ id: submissions.id })
    .from(submissions)
    .where(where)
    .orderBy(asc(submissions.createdAt))
    .limit(MAX_PER_RUN);
  const ids = idRows.map((r) => r.id);

  if (ids.length === 0) {
    return new Response(null, { status: 303, headers: { Location: backTo } });
  }

  // Reset exactly the rows we're about to enqueue (by id, chunked) — same field
  // clears as the single-row refetch — so the update set == the enqueue set and
  // no row is left pending without a queue message.
  for (const part of chunk(ids, 90)) {
    await drizzle
      .update(submissions)
      .set({
        status: "pending",
        processedAt: null,
        rejectReason: null,
        failureStage: null,
        aiSectionsError: null,
        processingStartedAt: new Date(),
        processingModel: "extract",
        rawR2Key: null,
        extractedLang: null,
      })
      .where(inArray(submissions.id, part));
  }

  // Enqueue to glean-ingest. sendBatch caps at 100 messages per batch.
  for (const part of chunk(ids, 100)) {
    await env.INGEST.sendBatch(part.map((id) => ({ body: id })));
  }

  // One "re-queued" event per row so each timeline shows the batch retry.
  // 7 columns/row → keep chunks under the ~100-bind D1 ceiling. Non-fatal:
  // the retry already happened; a lost event only dents the timeline panel.
  const now = new Date();
  const eventRows = ids.map((id) => ({
    id: ulid(),
    submissionId: id,
    stage: "queue" as const,
    status: "queued" as const,
    message: "batch refetch requested by admin",
    metaJson: JSON.stringify({ target: "glean-ingest", source: "batch-refetch" }),
    createdAt: now,
  }));
  try {
    for (const part of chunk(eventRows, 12)) {
      await drizzle.insert(submissionEvents).values(part);
    }
  } catch (err) {
    console.error("retry-failed: event log insert failed (retry still queued)", (err as Error).message);
  }

  console.log(`retry-failed: requeued ${ids.length} submissions${q ? ` matching "${q}"` : ""}`);
  return new Response(null, { status: 303, headers: { Location: backTo } });
};
