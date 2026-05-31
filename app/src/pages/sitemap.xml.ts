import type { APIRoute } from "astro";
import { desc, eq, isNotNull } from "drizzle-orm";
import { db } from "~/db/client";
import { picks, weeklyIssues } from "~/db/schema";
import { allTagsWithCounts } from "~/lib/queries";
import { buildSitemap, type SitemapEntry } from "~/lib/sitemap";

export const prerender = false;

/**
 * Runtime sitemap. The static `@astrojs/sitemap` integration only sees routes
 * known at build time; Glean's content (/a, /daily, /weekly, /tag) is SSR and
 * lives in D1, so we enumerate it here. robots.txt points crawlers at this URL.
 */
export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const base = (env.SITE_URL || ctx.url.origin).replace(/\/$/, "");
  const drizzle = db(env.DB);

  const [pickRows, weeklyRows, tagRows] = await Promise.all([
    drizzle
      .select({ slug: picks.slug, publishedAt: picks.publishedAt })
      .from(picks)
      .where(eq(picks.status, "published"))
      .orderBy(desc(picks.publishedAt)),
    drizzle
      .select({ number: weeklyIssues.number, publishedAt: weeklyIssues.publishedAt })
      .from(weeklyIssues)
      .where(isNotNull(weeklyIssues.publishedAt))
      .orderBy(desc(weeklyIssues.number)),
    allTagsWithCounts(drizzle),
  ]);

  // Distinct daily dates that have at least one published pick.
  const dailyDates = await drizzle
    .selectDistinct({ date: picks.dailyDate })
    .from(picks)
    .where(eq(picks.status, "published"))
    .orderBy(desc(picks.dailyDate));

  // Newest published pick stamps the lastmod on the listing/index pages.
  const newest = pickRows[0]?.publishedAt ?? null;

  // Language-agnostic base paths; the builder expands each into its zh + en
  // URLs with reciprocal hreflang alternates.
  const entries: SitemapEntry[] = [
    { basePath: "/", lastmod: newest },
    { basePath: "/weekly", lastmod: weeklyRows[0]?.publishedAt ?? newest },
    { basePath: "/daily", lastmod: newest },
    { basePath: "/tag", lastmod: newest },
    { basePath: "/about" },
    { basePath: "/standards" },
    ...pickRows.map((p) => ({ basePath: `/a/${p.slug}`, lastmod: p.publishedAt })),
    ...dailyDates.map((d) => ({ basePath: `/daily/${d.date}` })),
    ...weeklyRows.map((w) => ({ basePath: `/weekly/${w.number}`, lastmod: w.publishedAt })),
    ...tagRows.filter((t) => t.count > 0).map((t) => ({ basePath: `/tag/${t.slug}` })),
  ];

  return new Response(buildSitemap(base, entries), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};
