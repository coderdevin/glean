import type { APIRoute } from "astro";
import { eq, inArray } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { reconcileLayout, type LayoutSection } from "~/lib/weekly";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

function parseLayout(raw: FormDataEntryValue | null): LayoutSection[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => ({
        heading_zh: String(s.heading_zh ?? "").trim(),
        heading_en: String(s.heading_en ?? "").trim(),
        pick_ids: Array.isArray(s.pick_ids) ? s.pick_ids.map(String) : [],
      }))
      .filter((s) => s.pick_ids.length > 0);
  } catch {
    return [];
  }
}

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  const form = await ctx.request.formData();
  const layout = parseLayout(form.get("layout_json"));
  const get = (k: string) => String(form.get(k) ?? "").trim();

  const number = Number(get("number")) || issue.number;
  const slug = get("slug") || issue.slug;

  const prevLinked = await drizzleDb
    .select({ id: picks.id })
    .from(picks)
    .where(eq(picks.weeklyIssueId, id));
  const { linkIds, unlinkIds } = reconcileLayout(layout, prevLinked.map((r) => r.id));

  await drizzleDb
    .update(weeklyIssues)
    .set({
      number,
      slug,
      titleZh: get("title_zh"),
      titleEn: get("title_en"),
      dateStart: get("date_start"),
      dateEnd: get("date_end"),
      introZh: get("intro_zh"),
      introEn: get("intro_en"),
      layoutJson: JSON.stringify(layout),
    })
    .where(eq(weeklyIssues.id, id));

  if (unlinkIds.length > 0) {
    await drizzleDb.update(picks).set({ weeklyIssueId: null }).where(inArray(picks.id, unlinkIds));
  }
  if (linkIds.length > 0) {
    await drizzleDb.update(picks).set({ weeklyIssueId: id }).where(inArray(picks.id, linkIds));
  }

  await bustForWeekly(env.CACHE, { number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
