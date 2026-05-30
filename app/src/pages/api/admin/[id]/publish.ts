import type { APIRoute } from "astro";
import { asc, eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { parseBulletLines, parseTags, readAdminForm } from "~/lib/adminForm";
import { publishSubmission } from "~/lib/publish";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const form = await readAdminForm(ctx.request);

  const sRows = await db(env.DB).select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const sub = sRows[0];
  if (!sub) return new Response("not found", { status: 404 });
  if (sub.status === "published" && sub.linkedPickId) {
    return new Response(null, { status: 303, headers: { Location: `/admin/${id}` } });
  }
  // Single source of truth: only a 'ready' row is publishable. Reaching
  // 'ready' already guarantees the sections phase succeeded (status machine).
  if (sub.status !== "ready") {
    return new Response(
      `cannot publish: status is '${sub.status}', expected 'ready'`,
      { status: 409 },
    );
  }

  // Fields come from the editor's form here; the daily cron sources the same
  // fields from the submission's AI output (see lib/publish.ts).
  await publishSubmission(env, sub, {
    titleZh: form.title_zh,
    titleEn: form.title_en,
    summaryZh: form.summary_zh,
    summaryEn: form.summary_en,
    bullets: parseBulletLines(form.bullets_zh, form.bullets_en),
    tagSlugs: parseTags(form.tags),
    category: form.category,
    score: form.score,
    editorZh: form.editor_zh || null,
    editorEn: form.editor_en || null,
    submitter: form.submitter.trim() || null,
  });

  const next = await db(env.DB)
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.status, "ready"))
    .orderBy(asc(submissions.createdAt))
    .limit(1);
  const nextLoc = next[0]?.id ? `/admin/${next[0].id}` : "/admin";

  return new Response(null, { status: 303, headers: { Location: nextLoc } });
};
