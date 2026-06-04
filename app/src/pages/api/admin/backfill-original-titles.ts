/**
 * One-off backfill: populate submissions.original_title for rows that predate
 * migration 0015, reading the title stashed on the R2 object's customMetadata
 * at extract time (see ingest.ts processExtract).
 *
 * Admin-gated by middleware (ADMIN_EMAILS + Access). Processes a bounded batch
 * per call to stay under the Workers subrequest cap, and reports `remaining` so
 * the caller can loop:
 *
 *   let r; do { r = await (await fetch('/api/admin/backfill-original-titles',
 *     {method:'POST'})).json(); console.log(r); } while (r.remaining > 0);
 */
import type { APIRoute } from "astro";
import { and, isNull, isNotNull, eq, sql } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";

export const prerender = false;

const BATCH = 20; // worst case 1 select + 20 head + 20 update + 1 count = 42 < 50 cap

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const d = db(env.DB);

  const pending = await d
    .select({ id: submissions.id, key: submissions.rawR2Key })
    .from(submissions)
    .where(and(isNull(submissions.originalTitle), isNotNull(submissions.rawR2Key)))
    .limit(BATCH);

  let updated = 0;
  let noTitle = 0;
  let missing = 0;
  for (const row of pending) {
    if (!row.key) continue;
    const obj = await env.RAW.head(row.key);
    if (!obj) { missing++; continue; }
    const title = obj.customMetadata?.title?.trim();
    if (!title) { noTitle++; continue; }
    await d
      .update(submissions)
      .set({ originalTitle: title.slice(0, 256) })
      .where(eq(submissions.id, row.id));
    updated++;
  }

  // How many still lack a title after this batch (so the caller knows to loop).
  const counted = await d
    .select({ n: sql<number>`count(*)` })
    .from(submissions)
    .where(and(isNull(submissions.originalTitle), isNotNull(submissions.rawR2Key)));
  const remaining = counted[0]?.n ?? 0;

  return new Response(
    JSON.stringify({ ok: true, batch: pending.length, updated, noTitle, missing, remaining }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
};
