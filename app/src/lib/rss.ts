/**
 * Hand-rolled RSS 2.0 builder. No npm dep — RSS is small + stable. The
 * builder XML-escapes everything, wraps content in CDATA, and emits a
 * `<atom:link rel="self">` so feed validators stop complaining.
 */

export interface RssItem {
  guid: string;
  link: string;
  title: string;
  description: string;
  pubDate: Date;
  contentHtml?: string;
}

export interface RssChannel {
  title: string;
  description: string;
  link: string;
  selfLink: string;
  language: string;
  items: RssItem[];
}

export function buildRss(c: RssChannel): string {
  const items = c.items.map(itemXml).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xml(c.title)}</title>
    <link>${xml(c.link)}</link>
    <description>${xml(c.description)}</description>
    <language>${xml(c.language)}</language>
    <atom:link href="${xml(c.selfLink)}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>
`;
}

function itemXml(i: RssItem): string {
  return `<item>
      <guid isPermaLink="false">${xml(i.guid)}</guid>
      <link>${xml(i.link)}</link>
      <title>${xml(i.title)}</title>
      <pubDate>${i.pubDate.toUTCString()}</pubDate>
      <description>${cdata(i.description)}</description>${
        i.contentHtml ? `\n      <content:encoded>${cdata(i.contentHtml)}</content:encoded>` : ""
      }
    </item>`;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
