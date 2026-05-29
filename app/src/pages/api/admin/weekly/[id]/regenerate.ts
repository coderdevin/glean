import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { callLlmWeekly, type WeeklyPickInput } from "~/lib/llm";
import { repairWeeklyDraft } from "~/lib/weekly";
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

  const linked = await drizzleDb.select().from(picks).where(eq(picks.weeklyIssueId, id));
  if (linked.length === 0) {
    return new Response("no picks linked to this issue", { status: 422 });
  }

  const aiPicks: WeeklyPickInput[] = linked.map((p) => ({
    id: p.id,
    title_zh: p.titleZh,
    title_en: p.titleEn,
    summary_zh: p.summaryZh,
    summary_en: p.summaryEn,
    category: p.category,
  }));

  let ai;
  try {
    const res = await callLlmWeekly(env, {
      title: "",
      body: "",
      picks: aiPicks,
      dateStart: issue.dateStart,
      dateEnd: issue.dateEnd,
    });
    ai = res.output;
  } catch (err) {
    return new Response(`AI 起草失败：${String(err)}`, { status: 502 });
  }

  const layout = repairWeeklyDraft(ai, linked.map((p) => p.id));

  await drizzleDb
    .update(weeklyIssues)
    .set({
      titleZh: ai.title_zh,
      titleEn: ai.title_en,
      introZh: ai.intro_zh,
      introEn: ai.intro_en,
      layoutJson: JSON.stringify(layout),
    })
    .where(eq(weeklyIssues.id, id));

  await bustForWeekly(env.CACHE, { number: issue.number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
