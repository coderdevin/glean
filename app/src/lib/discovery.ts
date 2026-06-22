/**
 * Auto-discovery: pull candidate URLs from RSS/HN/arXiv, dedup, gate-1
 * prescore, and enqueue survivors into the existing submission pipeline.
 * Parsers here are PURE (string/JSON in → Candidate[] out) so they unit-test
 * without network. Network + orchestration live in runDiscovery (below).
 */

export interface Candidate {
  /** Raw URL as found in the source (normalized later, at dedup time). */
  url: string;
  title: string;
  snippet: string;
  /** "auto:hn" | "auto:arxiv" | "auto:rss:<id>" — becomes submissions.source. */
  source: string;
}

/** Minimal HTML/XML entity decode for titles/snippets pulled from feeds. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Strip CDATA wrappers and tags, collapse whitespace. */
function clean(s: string): string {
  return decodeEntities(
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
}

function firstMatch(block: string, re: RegExp): string {
  const m = block.match(re);
  return m ? clean(m[1] ?? "") : "";
}

/**
 * Parse an RSS 2.0 or Atom feed. `sourceId` is the config id (e.g.
 * "rss:simonwillison"); the emitted source is `auto:<sourceId>`.
 * Tolerant by design: regex over <item>/<entry> blocks, no XML lib.
 */
export function parseFeed(xml: string, sourceId: string): Candidate[] {
  const source = `auto:${sourceId}`;
  const out: Candidate[] = [];
  // RSS <item> ... </item> OR Atom <entry> ... </entry>
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/g) ?? [];
  for (const block of blocks) {
    const title = firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/);
    // RSS: <link>URL</link>. Atom: <link href="URL" .../> (prefer rel=alternate).
    let url = firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/);
    if (!url) {
      const atom =
        block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
        block.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = atom ? decodeEntities(atom[1] ?? "") : "";
    }
    const snippet =
      firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/) ||
      firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/) ||
      firstMatch(block, /<content[^>]*>([\s\S]*?)<\/content>/);
    if (url && title) out.push({ url, title, snippet: snippet.slice(0, 500), source });
  }
  return out;
}

interface HnHit {
  title?: string | null;
  url?: string | null;
  points?: number | null;
  objectID?: string | null;
}

/** Parse a Hacker News Algolia search response, keeping story hits with a real
 *  URL and at least `minPoints` points. */
export function parseHnHits(json: { hits?: HnHit[] }, minPoints: number): Candidate[] {
  const hits = json.hits ?? [];
  const out: Candidate[] = [];
  for (const h of hits) {
    if (!h.url || !h.title) continue; // Ask HN / job posts have no url
    if ((h.points ?? 0) < minPoints) continue;
    out.push({
      url: h.url,
      title: clean(h.title),
      snippet: `HN ${h.points ?? 0} points`,
      source: "auto:hn",
    });
  }
  return out;
}

/** Parse an arXiv API (Atom) response. The canonical URL is the <id> abs link. */
export function parseArxivXml(xml: string): Candidate[] {
  const out: Candidate[] = [];
  const blocks = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];
  for (const block of blocks) {
    const title = firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/);
    const url = firstMatch(block, /<id[^>]*>([\s\S]*?)<\/id>/);
    const snippet = firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/);
    if (url && title && /arxiv\.org\/abs\//.test(url)) {
      out.push({ url, title, snippet: snippet.slice(0, 500), source: "auto:arxiv" });
    }
  }
  return out;
}
