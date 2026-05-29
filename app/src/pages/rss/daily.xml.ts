import type { APIRoute } from "astro";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "~/db/client";
import { picks } from "~/db/schema";
import { buildRss } from "~/lib/rss";

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const url = new URL(ctx.request.url);
  const lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
  const siteUrl = env.SITE_URL || url.origin;

  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  const rows = await db(env.DB)
    .select()
    .from(picks)
    .where(and(eq(picks.status, "published"), gte(picks.publishedAt, since)))
    .orderBy(desc(picks.publishedAt))
    .limit(100);

  const xml = buildRss({
    title: lang === "en" ? "Glean · Daily" : "Glean · 日刊",
    description: lang === "en"
      ? "A bilingual tech daily — hand-curated, human-reviewed."
      : "双语技术日刊 · 每条人审。",
    link: siteUrl,
    selfLink: `${siteUrl}/rss/daily.xml${lang === "en" ? "?lang=en" : ""}`,
    language: lang === "en" ? "en" : "zh-CN",
    items: rows.map((p) => ({
      guid: p.id,
      link: `${siteUrl}/a/${p.slug}`,
      title: lang === "en" ? p.titleEn : p.titleZh,
      description: lang === "en" ? p.summaryEn : p.summaryZh,
      pubDate: p.publishedAt ?? p.createdAt ?? new Date(),
    })),
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    },
  });
};
