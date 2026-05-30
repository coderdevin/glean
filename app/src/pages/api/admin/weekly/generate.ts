/**
 * Admin: generate a new weekly issue draft from a date range.
 *
 * Architecture: the AI draft (V4-Pro) takes 30s–2min, well past the ~30s
 * Cloudflare Pages SSR wall-clock cap, so we can't await it here. Instead we
 * create the issue row immediately with placeholder copy + draft_status =
 * 'drafting', link the eligible picks, enqueue a `<id>|kind=weekly` message to
 * the glean-llm queue (15-min worker budget), and 303 to the editor — which
 * polls until runWeeklyDraft flips draft_status to 'ready' | 'failed'.
 *
 * Dev mode: proxy straight to the local llm-consumer fetch handler (same as
 * regenerate-sections.ts) so the draft fires without the dev queue poller.
 */
import type { APIRoute } from "astro";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { ulid } from "~/lib/ulid";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { thisWeekToDate } from "~/lib/weekly";
import { maxWeeklyNumber } from "~/lib/queries";
import { logEvent } from "~/lib/ingest";
import { siteTz } from "~/lib/datetime";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

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

  // Create the issue row up front with placeholder copy so the editor can land
  // on the detail page and poll. runWeeklyDraft fills in the real title/intro
  // and themed layout once the LLM returns.
  const id = ulid();
  const number = (await maxWeeklyNumber(drizzleDb)) + 1;
  const slug = `issue-${String(number).padStart(3, "0")}`;
  const now = new Date();

  await drizzleDb.insert(weeklyIssues).values({
    id,
    number,
    slug,
    titleZh: "AI 起草中…",
    titleEn: "Drafting…",
    dateStart,
    dateEnd,
    introZh: "",
    introEn: "",
    coverImageKey: null,
    layoutJson: null,
    draftStatus: "drafting",
    draftError: null,
    draftStartedAt: now,
    publishedAt: null,
    createdAt: now,
  });

  // Link the eligible picks now so runWeeklyDraft (which reads from the linked
  // set) sees them. repairWeeklyDraft guarantees each ends up in the layout.
  await drizzleDb
    .update(picks)
    .set({ weeklyIssueId: id })
    .where(inArray(picks.id, eligible.map((p) => p.id)));

  await logEvent(env, id, "queue", "queued", {
    message: "weekly draft requested by admin",
    meta: { target: "glean-llm", source: "generate", kind: "weekly", picks: eligible.length },
  });

  if (import.meta.env.DEV) {
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    proxyUrl.searchParams.set("kind", "weekly");
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(`${id}|kind=weekly`);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/weekly/${id}` } });
};
