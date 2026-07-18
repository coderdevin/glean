import type { APIRoute } from "astro";
import { eq, inArray } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { reconcileLayout, type LayoutSection } from "~/lib/weekly";
import { bustForWeekly } from "~/lib/cache";

export const prerender = false;

/** Split into ≤`size` batches. D1 caps a query at 100 bound parameters, so
 *  pick-link updates must be chunked before the `inArray(picks.id, …)` list. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
      // A manual save means the editor has taken the draft over — clear any
      // prior 'failed' state so the error banner doesn't linger on reload.
      draftStatus: "ready",
      draftError: null,
    })
    .where(eq(weeklyIssues.id, id));

  // Chunk both link syncs under D1's 100-bound-parameter cap — a big issue can
  // carry hundreds of ids, and one oversized UPDATE would throw mid-save.
  for (const part of chunk(unlinkIds, 90)) {
    await drizzleDb.update(picks).set({ weeklyIssueId: null }).where(inArray(picks.id, part));
  }
  for (const part of chunk(linkIds, 90)) {
    await drizzleDb.update(picks).set({ weeklyIssueId: id }).where(inArray(picks.id, part));
  }

  await bustForWeekly(env.CACHE, { number });
  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
