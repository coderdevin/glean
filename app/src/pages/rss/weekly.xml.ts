import type { APIRoute } from "astro";
import { desc, isNotNull } from "drizzle-orm";
import { db } from "~/db/client";
import { weeklyIssues } from "~/db/schema";
import { buildRss } from "~/lib/rss";

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const url = new URL(ctx.request.url);
  const lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
  const siteUrl = env.SITE_URL || url.origin;

  const rows = await db(env.DB)
    .select()
    .from(weeklyIssues)
    .where(isNotNull(weeklyIssues.publishedAt))
    .orderBy(desc(weeklyIssues.number))
    .limit(26);

  const xml = buildRss({
    title: lang === "en" ? "Glean · Weekly" : "Glean · 周刊",
    description: lang === "en"
      ? "One bilingual tech digest every Monday."
      : "每周一一期 · 双语技术精选。",
    link: siteUrl,
    selfLink: `${siteUrl}/rss/weekly.xml${lang === "en" ? "?lang=en" : ""}`,
    language: lang === "en" ? "en" : "zh-CN",
    items: rows.map((w) => ({
      guid: w.id,
      link: `${siteUrl}/weekly/${w.number}`,
      title: `#${String(w.number).padStart(3, "0")} — ${lang === "en" ? w.titleEn : w.titleZh}`,
      description: lang === "en" ? w.introEn : w.introZh,
      pubDate: w.publishedAt ?? w.createdAt ?? new Date(),
    })),
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
    },
  });
};
