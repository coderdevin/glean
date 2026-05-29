import type { APIRoute } from "astro";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { ulid } from "~/lib/ulid";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { callLlmWeekly, toWeeklyPickInput } from "~/lib/llm";
import { thisWeekToDate, repairWeeklyDraft } from "~/lib/weekly";
import { maxWeeklyNumber } from "~/lib/queries";
import { bustForWeekly } from "~/lib/cache";
import { siteTz } from "~/lib/datetime";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const drizzleDb = db(env.DB);

  // Range is editable from the generate form; default to the current week so
  // far. Fall back to that default for any missing/malformed date field.
  const def = thisWeekToDate(new Date(), siteTz(env));
  const form = await ctx.request.formData().catch(() => null);
  const pickDate = (key: string, fallback: string): string => {
    const v = form?.get(key);
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
  };
  const dateStart = pickDate("date_start", def.dateStart);
  const dateEnd = pickDate("date_end", def.dateEnd);

  const eligible = await drizzleDb
    .select()
    .from(picks)
    .where(
      and(
        eq(picks.status, "published"),
        isNull(picks.weeklyIssueId),
        gte(picks.dailyDate, dateStart),
        lte(picks.dailyDate, dateEnd),
      ),
    )
    .orderBy(asc(picks.dailyDate), asc(picks.positionInDay));

  if (eligible.length === 0) {
    return new Response(
      `${dateStart} → ${dateEnd} 没有可收录的篇目。No eligible picks in this range.`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const aiPicks = eligible.map(toWeeklyPickInput);

  let ai;
  try {
    const res = await callLlmWeekly(env, { title: "", body: "", picks: aiPicks, dateStart, dateEnd });
    ai = res.output;
  } catch (err) {
    return new Response(`AI 起草失败：${String(err)}`, { status: 502 });
  }

  const layout = repairWeeklyDraft(ai, eligible.map((p) => p.id));

  const id = ulid();
  const number = (await maxWeeklyNumber(drizzleDb)) + 1;
  const slug = `issue-${String(number).padStart(3, "0")}`;
  const now = new Date();

  await drizzleDb.insert(weeklyIssues).values({
    id,
    number,
    slug,
    titleZh: ai.title_zh,
    titleEn: ai.title_en,
    dateStart,
    dateEnd,
    introZh: ai.intro_zh,
    introEn: ai.intro_en,
    coverImageKey: null,
    layoutJson: JSON.stringify(layout),
    publishedAt: null,
    createdAt: now,
  });

  const linkIds = layout.flatMap((s) => s.pick_ids);
  if (linkIds.length > 0) {
    await drizzleDb.update(picks).set({ weeklyIssueId: id }).where(inArray(picks.id, linkIds));
  }

  await bustForWeekly(env.CACHE, { number });

  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
