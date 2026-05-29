import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { parseBulletLines, parseTags, readAdminForm } from "~/lib/adminForm";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const form = await readAdminForm(ctx.request);
  const bullets = parseBulletLines(form.bullets_zh, form.bullets_en);
  const tags = parseTags(form.tags);

  await db(env.DB).update(submissions).set({
    aiTitleZh: form.title_zh || null,
    aiTitleEn: form.title_en || null,
    aiSummaryZh: form.summary_zh || null,
    aiSummaryEn: form.summary_en || null,
    aiBulletsJson: JSON.stringify(bullets),
    aiTagsJson: JSON.stringify(tags),
    aiCategory: form.category,
    aiScore: form.score,
    editorNoteZh: form.editor_zh || null,
    editorNoteEn: form.editor_en || null,
    submitterName: form.submitter.trim() || null,
  }).where(eq(submissions.id, id));

  return new Response(null, { status: 303, headers: { Location: `/admin/${id}` } });
};
