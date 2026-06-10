/**
 * Admin: unpublish a published pick (status → 'draft', NOT a delete — the row
 * keeps everything and can be re-published by hand if needed).
 *
 * Side effects that keep the public surfaces honest:
 * - cache bust (home/daily/article/tag/RSS) via bustForPick
 * - the live wiki map drops the slug (corrected copy becomes the new version),
 *   so /wiki never links a 404
 *
 * form: slug=<pick slug>  [back=<redirect path>]
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, pickTags } from "~/db/schema";
import { bustForPick } from "~/lib/cache";
import { removeFromWikiIndex } from "~/lib/wiki";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;

  let slug = "";
  let back = "/admin/wiki";
  try {
    const fd = await ctx.request.formData();
    slug = String(fd.get("slug") ?? "").trim();
    const b = String(fd.get("back") ?? "").trim();
    if (b.startsWith("/admin")) back = b;
  } catch {
    return new Response("expected form data", { status: 400 });
  }
  if (!slug) return new Response("missing slug", { status: 400 });

  const drizzleDb = db(env.DB);
  const rows = await drizzleDb.select().from(picks).where(eq(picks.slug, slug)).limit(1);
  const pick = rows[0];

  if (pick && pick.status === "published") {
    await drizzleDb.update(picks).set({ status: "draft" }).where(eq(picks.id, pick.id));
    const tagRows = await drizzleDb
      .select({ slug: pickTags.tagSlug })
      .from(pickTags)
      .where(eq(pickTags.pickId, pick.id));
    await bustForPick(
      env.CACHE,
      { slug: pick.slug, dailyDate: pick.dailyDate, weeklyIssueId: pick.weeklyIssueId },
      tagRows.map((t) => t.slug),
    ).catch(() => {});
  }

  // Always repair the live map — this same endpoint serves the lint
  // "wiki-dead-link" fix, where the pick is already draft (or long gone) but
  // the wiki still links it.
  await removeFromWikiIndex(env.DB, [slug]);

  return new Response(null, { status: 303, headers: { Location: back } });
};
