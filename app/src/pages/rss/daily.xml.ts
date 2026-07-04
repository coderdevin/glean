import type { APIRoute } from "astro";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "~/db/client";
import { picks } from "~/db/schema";
import { buildRss } from "~/lib/rss";
import { renderMarkdown } from "~/lib/markdown";

export const prerender = false;

type Section = { heading_zh: string; heading_en: string; body_zh: string; body_en: string };

/** HTML-escape a plain-text heading before interpolating it into markup. The
 *  body is sanitized by markdown-it (`html:false`); the heading isn't rendered
 *  through it, so escape it here to keep the same guard against raw markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Full article body for <content:encoded>, matching what /a/[slug] renders
 *  (minus the reader chrome): each section's localized heading + markdown body. */
function renderFullContent(sectionsJson: string | null, lang: "zh" | "en"): string {
  let sections: Section[];
  try {
    sections = JSON.parse(sectionsJson ?? "[]");
  } catch {
    return "";
  }
  return sections
    .map((s) => {
      const heading = lang === "en" ? s.heading_en : s.heading_zh;
      const body = lang === "en" ? s.body_en : s.body_zh;
      return `<h2>${escapeHtml(heading)}</h2>\n${renderMarkdown(body)}`;
    })
    .join("\n");
}

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const url = new URL(ctx.request.url);
  const lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
  const siteUrl = env.SITE_URL || url.origin;

  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  const rows = await db(env.DB)
    .select()
    .from(picks)
    // isNull(albumId): album picks live only in their album, never the daily
    // RSS stream (see docs/adr/0002).
    .where(and(eq(picks.status, "published"), isNull(picks.albumId), gte(picks.publishedAt, since)))
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
      contentHtml: renderFullContent(p.sectionsJson, lang),
    })),
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    },
  });
};
