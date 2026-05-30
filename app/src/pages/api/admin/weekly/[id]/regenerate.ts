/**
 * Admin: re-draft an existing weekly issue with the LLM.
 *
 * The date range is AUTHORITATIVE on re-draft: we re-select which picks belong
 * to the issue from its (current) range, then re-theme that set. Concretely —
 *   - in-range published picks that are free or already ours → (re)linked
 *   - currently-linked picks now outside the range → released to the pool
 * The range comes from the submitted form (this route is the formaction target
 * of weekly-form) so editing the dates + re-drafting works in one click; it
 * falls back to the issue's saved range for any missing/malformed field.
 *
 * Async, same as generate.ts: set draft_status='drafting', enqueue a
 * `<id>|kind=weekly` message to the glean-llm queue, and 303 to the editor
 * immediately. runWeeklyDraft (in the 15-min worker) writes the new
 * title/intro/layout. The Pages SSR ~30s cap means we can never await the
 * V4-Pro stream here.
 */
import type { APIRoute } from "astro";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { weeklyById } from "~/lib/queries";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  // Block a re-draft while one is already running, so a double-submit can't
  // race two workers onto the same row.
  if (issue.draftStatus === "drafting") {
    return new Response("draft already in progress", { status: 409 });
  }

  // Range: prefer the just-submitted form values (weekly-form posts here via
  // formaction), fall back to the issue's saved range per field.
  const form = await ctx.request.formData().catch(() => null);
  const pickDate = (key: string, fallback: string): string => {
    const v = form?.get(key);
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
  };
  const dateStart = pickDate("date_start", issue.dateStart);
  const dateEnd = pickDate("date_end", issue.dateEnd);

  // Re-select picks by range. A pick is in scope if it's published, dated in
  // [start, end], and either free or already linked to THIS issue (never steal
  // a pick that belongs to another issue).
  const inRange = await drizzleDb
    .select({ id: picks.id })
    .from(picks)
    .where(
      and(
        eq(picks.status, "published"),
        gte(picks.dailyDate, dateStart),
        lte(picks.dailyDate, dateEnd),
        or(isNull(picks.weeklyIssueId), eq(picks.weeklyIssueId, id)),
      ),
    );
  const targetIds = inRange.map((p) => p.id);

  // Empty range → don't strand the issue with zero picks; bail before mutating.
  if (targetIds.length === 0) {
    return new Response(
      `${dateStart} → ${dateEnd} 没有可收录的篇目。No eligible picks in this range.`,
      { status: 422, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const currentlyLinked = await drizzleDb
    .select({ id: picks.id })
    .from(picks)
    .where(eq(picks.weeklyIssueId, id));
  const targetSet = new Set(targetIds);
  const unlinkIds = currentlyLinked.map((p) => p.id).filter((pid) => !targetSet.has(pid));

  // Persist the range used + reset draft state, then sync the pick links.
  await drizzleDb
    .update(weeklyIssues)
    .set({
      dateStart,
      dateEnd,
      draftStatus: "drafting",
      draftError: null,
      draftStartedAt: new Date(),
    })
    .where(eq(weeklyIssues.id, id));

  if (unlinkIds.length > 0) {
    await drizzleDb.update(picks).set({ weeklyIssueId: null }).where(inArray(picks.id, unlinkIds));
  }
  await drizzleDb.update(picks).set({ weeklyIssueId: id }).where(inArray(picks.id, targetIds));

  await logEvent(env, id, "queue", "queued", {
    message: "weekly re-draft requested by admin",
    meta: {
      target: "glean-llm",
      source: "regenerate",
      kind: "weekly",
      picks: targetIds.length,
      unlinked: unlinkIds.length,
      range: `${dateStart}→${dateEnd}`,
    },
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
