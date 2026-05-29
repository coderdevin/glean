import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });
  if (!issue.titleZh.trim() || !issue.titleEn.trim() || !issue.introZh.trim() || !issue.introEn.trim()) {
    return new Response("cannot publish: title and intro (zh + en) are required", { status: 422 });
  }

  await drizzleDb
    .update(weeklyIssues)
    .set({ publishedAt: new Date() })
    .where(eq(weeklyIssues.id, id));

  await bustForWeekly(env.CACHE, { number: issue.number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
