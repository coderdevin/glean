/**
 * Minimal sitemaps.org 0.9 builder with xhtml:link hreflang alternates. No npm
 * dep — the format is tiny + stable, mirroring the hand-rolled RSS builder in
 * `rss.ts`.
 *
 * Each entry is a language-agnostic `basePath`; the builder expands it into one
 * <url> per language (zh at root, en under /en) and gives every <url> the full
 * reciprocal set of <xhtml:link rel="alternate" hreflang>. This is exactly the
 * shape Google wants for clustering a bilingual page pair.
 *
 * A single <urlset> holds up to 50,000 URLs before the spec requires sharding
 * into a <sitemapindex>. With two languages that's ~25k base paths; split into
 * per-section child sitemaps behind an index when the pick count approaches it.
 */
import { LANGS, hreflangCode, localizedPath } from "~/lib/i18n";

export interface SitemapEntry {
  /** Language-agnostic path, e.g. "/a/my-slug" or "/". */
  basePath: string;
  /** Last-modified — ISO 8601. Omit when unknown (e.g. static pages). */
  lastmod?: Date | null;
}

export function buildSitemap(origin: string, entries: SitemapEntry[]): string {
  const alternatesFor = (basePath: string): string =>
    [
      ...LANGS.map(
        (l) =>
          `    <xhtml:link rel="alternate" hreflang="${hreflangCode(l)}" href="${xml(origin + localizedPath(basePath, l))}" />`,
      ),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(origin + localizedPath(basePath, "zh"))}" />`,
    ].join("\n");

  const urls = entries
    .flatMap((e) =>
      LANGS.map((l) => {
        const loc = origin + localizedPath(e.basePath, l);
        const lastmod = e.lastmod
          ? `\n    <lastmod>${e.lastmod.toISOString()}</lastmod>`
          : "";
        return `  <url>\n    <loc>${xml(loc)}</loc>${lastmod}\n${alternatesFor(e.basePath)}\n  </url>`;
      }),
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
