/**
 * WeChat Official Account (mp.weixin.qq.com) article extractor.
 *
 * WeChat server-renders the full article into `<div id="js_content">` but
 * ships it hidden — `style="visibility: hidden; opacity: 0;"` — and reveals it
 * with JS once the page loads. Mozilla Readability treats any `visibility:hidden`
 * subtree as invisible and removes it (Readability.js `_isProbablyVisible`), so
 * the generic Tier-2 path keeps only WeChat's page chrome (cover image, author
 * block, "继续滑动看下一个" footer nav) — roughly 300 chars of furniture that
 * still clears the 200-char floor. The pipeline then accepts that junk as a
 * successful extract and never falls through to Jina: the editor's "Refetch"
 * silently yields a body with no article in it.
 *
 * Fix: read `#js_content` directly. It IS the clean article container (no
 * nav/footer inside it), so we hand its innerHTML to the shared image-aware
 * text walker — which already resolves WeChat's lazy `data-src` images — and
 * skip Readability's visibility heuristics entirely. Title/author come from the
 * og: meta tags (WeChat ships an empty <title>). On a too-short body or a
 * missing #js_content (deleted article / anti-bot interstitial) we throw, and
 * extract.ts falls through to Jina.
 */
import type { ExtractResult } from "./extract";
import { fetchWithTimeout, htmlToTextWithImages, MAX_BODY_BYTES } from "./extract";
import { parseHTML } from "linkedom";
import { detectLang } from "./lang";

const FETCH_TIMEOUT_MS = 25_000;

/** Detect — used by extract.ts to decide whether to dispatch here. */
export function isWeixinUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).host.toLowerCase() === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

export async function extractFromWechat(url: string): Promise<ExtractResult> {
  const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  return extractWechatFromHtml(html, url);
}

/** Pure parse step — split out from the fetch so it's unit-testable offline. */
export function extractWechatFromHtml(html: string, url: string): ExtractResult {
  const safe = /^\s*<!doctype/i.test(html) ? html : `<!doctype html>${html}`;
  const { document } = parseHTML(safe);

  const content = document.querySelector("#js_content");
  if (!content) {
    // No article container — a deleted post, a non-article WeChat URL, or an
    // anti-bot interstitial served to datacenter egress. Let the caller try Jina.
    throw new Error("wechat: #js_content not found (deleted article or anti-bot page)");
  }

  const body = htmlToTextWithImages((content as { innerHTML?: string }).innerHTML ?? "", url);
  if (body.length < 200) {
    throw new Error(`wechat: #js_content body too short (${body.length} chars)`);
  }

  const title =
    document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    document.querySelector("#activity-name")?.textContent?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    "";

  const text = body.slice(0, MAX_BODY_BYTES);
  return {
    title,
    textContent: text,
    detectedLang: detectLang(text),
    truncated: body.length > MAX_BODY_BYTES,
  };
}
