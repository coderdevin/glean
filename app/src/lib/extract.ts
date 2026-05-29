/**
 * Article body extraction — fetch URL, parse HTML, run Mozilla Readability.
 *
 * Runs in the Workers runtime (both the queue consumer and Pages Functions
 * since linkedom + @mozilla/readability are pure-JS, no Node bindings).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { isXUrl, extractFromX } from "./extract-x";
import { extractViaJina } from "./extract-jina";

const FETCH_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 200_000;

export interface ExtractResult {
  title: string;
  textContent: string;
  detectedLang: "zh" | "en" | "other";
  truncated: boolean;
}

/**
 * Three-tier extraction chain:
 *   1. site-specific (currently just X.com → fxtwitter API)
 *   2. Readability + linkedom — static-HTML article pages (free, in-Workers)
 *   3. Jina Reader (https://r.jina.ai) — SPA / JS-heavy / anti-bot sites
 *      Falls back here when (2) returns < 200 chars or throws. Anonymous tier,
 *      no key required (set JINA_API_KEY env to raise the 20 req/min limit).
 */
export async function extractFromUrl(
  url: string,
  opts?: { baseUrl?: string; jinaApiKey?: string },
): Promise<ExtractResult> {
  if (isXUrl(url)) {
    return extractFromX(url);
  }

  // Tier 2: Readability — keep error to report if Jina also fails.
  let readabilityError: Error | null = null;
  try {
    const result = await extractViaReadability(url, opts?.baseUrl ?? url);
    if (result.textContent.length >= 200) return result;
    readabilityError = new Error(
      `readability body too short (${result.textContent.length} chars)`,
    );
  } catch (err) {
    readabilityError = err as Error;
  }

  // Tier 3: Jina Reader fallback.
  try {
    return await extractViaJina(url, opts?.jinaApiKey ? { JINA_API_KEY: opts.jinaApiKey } : undefined);
  } catch (jinaErr) {
    throw new Error(
      `extract failed — readability: ${readabilityError?.message ?? "n/a"}; ` +
        `jina: ${(jinaErr as Error).message}`,
    );
  }
}

/** Tier 2: Readability + linkedom. Same logic as the previous extractFromUrl. */
async function extractViaReadability(url: string, baseUrl: string): Promise<ExtractResult> {
  const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  const safe = ensureDoctype(html);
  const { document } = parseHTML(safe);

  let title = "";
  let body = "";
  try {
    const reader = new Readability(document as unknown as Document, { charThreshold: 200 });
    const article = reader.parse();
    if (article && (article.content || article.textContent)) {
      title = article.title ?? "";
      body = article.content
        ? htmlToTextWithImages(article.content, baseUrl)
        : article.textContent;
    }
  } catch (err) {
    console.warn("readability threw, falling back", (err as Error).message);
  }
  if (body.length < 200) {
    const fallback = manualExtract(document as unknown as Document, baseUrl);
    if (fallback && fallback.body.length >= 200) {
      title = title || fallback.title;
      body = fallback.body;
    }
  }
  const text = body.slice(0, MAX_BODY_BYTES);
  return {
    title: title.trim(),
    textContent: text,
    detectedLang: detectLang(text),
    truncated: body.length > MAX_BODY_BYTES,
  };
}

/**
 * Walk Readability's cleaned HTML and turn it into plain text + inline image
 * markdown. The LLM downstream sees something like:
 *
 *   First paragraph text.
 *
 *   ![alt for figure 1](https://cdn.example.com/img-1.png)
 *
 *   Second paragraph...
 *
 * Block elements (p / li / h* / blockquote / pre) become paragraph breaks.
 * Anything else collapses to inline text. Image URLs are absolutized against
 * the source URL so relative `src="/img/foo.png"` survives.
 */
function htmlToTextWithImages(html: string, baseUrl: string): string {
  // linkedom is fussy about fragment wrapping — `<!doctype html><body>X</body>`
  // produces a malformed tree with `<body>` empty and X as a sibling. The
  // full `<html><body>` envelope works reliably.
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body;
  if (!body) return "";

  // Strip junk that survived Readability (scripts, styles, embeds we can't use).
  body.querySelectorAll("script, style, iframe, noscript").forEach((n) => n.remove());

  // Replace each <img> with a text-node carrying its markdown form, anchored
  // by surrounding blank lines so the LLM sees it as its own paragraph.
  body.querySelectorAll("img").forEach((img) => {
    const rawSrc = img.getAttribute("src") || img.getAttribute("data-src") || "";
    const alt = (img.getAttribute("alt") || "").replace(/[\[\]\n]/g, " ").trim();
    if (!rawSrc) {
      img.remove();
      return;
    }
    const abs = absolutize(rawSrc, baseUrl);
    const md = `\n\n![${alt}](${abs})\n\n`;
    img.replaceWith(document.createTextNode(md));
  });

  // Inject paragraph breaks at the end of every block element so textContent
  // doesn't smash everything into one wall.
  const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, div, br";
  body.querySelectorAll(BLOCKS).forEach((el) => {
    el.appendChild(document.createTextNode("\n\n"));
  });

  const raw = body.textContent ?? "";
  return raw
    .replace(/[ \t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absolutize(src: string, base: string): string {
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

function ensureDoctype(html: string): string {
  if (/^\s*<!doctype/i.test(html)) return html;
  return `<!doctype html>${html}`;
}

interface ManualArticle {
  title: string;
  body: string;
}

function manualExtract(doc: Document, baseUrl: string): ManualArticle | null {
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  const main =
    doc.querySelector("article") ??
    doc.querySelector("main") ??
    doc.querySelector("[role='main']") ??
    doc.body;
  if (!main) return null;
  // Strip noise — script, style, nav, footer, aside, header.
  const trash = main.querySelectorAll("script, style, nav, footer, aside, header, .ads, .ad, .nav, .footer");
  trash.forEach((el) => el.remove());
  // Use the same HTML→text+images walker as the main path so image
  // markdown survives the fallback too.
  const body = htmlToTextWithImages((main as any).innerHTML ?? "", baseUrl);
  return body ? { title, body } : null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  // Retry once on 429/5xx after a short backoff — Cloudflare-fronted sites
  // (including blog.cloudflare.com itself) occasionally throttle bursty
  // worker egress; a single 2s wait usually clears it before we fall to
  // the more expensive Jina path.
  const attempt = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "accept-encoding": "gzip, deflate, br",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await attempt();
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await attempt();
    }
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (msg.toLowerCase().includes("abort")) {
      throw new Error(`fetch timed out after ${(ms / 1000) | 0}s — try "Paste body" or "Refetch" later`);
    }
    throw new Error(`fetch failed: ${msg.slice(0, 200)}`);
  }
  if (!res.ok) {
    const host = (() => { try { return new URL(url).host; } catch { return url.slice(0, 60); } })();
    throw new Error(`fetch ${res.status} from ${host}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("html")) throw new Error(`not html (${ct})`);
  return await res.text();
}

function detectLang(text: string): "zh" | "en" | "other" {
  const sample = text.slice(0, 500);
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > latin * 0.3) return "zh";
  if (latin > cjk * 2) return "en";
  return "other";
}
