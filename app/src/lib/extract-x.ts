/**
 * X / Twitter article extractor.
 *
 * X.com is a client-rendered SPA — `fetch(url)` returns a React skeleton
 * with zero tweet text in the HTML. Even og:description is stripped now.
 * So we can't use Readability; we use the fxtwitter community API, which
 * scrapes X server-side and returns clean JSON:
 *
 *   https://api.fxtwitter.com/<screen_name>/status/<id>
 *
 * Two cases we care about:
 *   1. **X Article** (long-form post, `tweet.article` present) — full DraftJS
 *      body with headings/images. This is what Glean was built for.
 *   2. **Plain tweet** (`tweet.text` only) — short. We still surface it, but
 *      Glean's pipeline (sections + 200-char floor) is not really tuned for
 *      sub-200-word tweets. Users get a clear error in that case.
 */
import type { ExtractResult } from "./extract";

const FXTWITTER_BASE = "https://api.fxtwitter.com";
const FETCH_TIMEOUT_MS = 20_000;

/** Match a tweet URL on x.com / twitter.com / nitter.* and pull out the
 *  screen name + status id. Mobile / m. subdomains are also accepted. */
export function parseTweetUrl(rawUrl: string): { screenName: string; statusId: string } | null {
  try {
    const u = new URL(rawUrl);
    const host = u.host.toLowerCase().replace(/^www\./, "").replace(/^m\.|^mobile\./, "");
    if (
      host !== "x.com" &&
      host !== "twitter.com" &&
      host !== "fxtwitter.com" &&
      host !== "vxtwitter.com" &&
      !host.endsWith("nitter.net")
    ) {
      return null;
    }
    const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    // u.pathname may be percent-encoded (e.g. /%40foo/...). Decode before
    // the API call re-encodes — otherwise valid handles get double-encoded
    // and fxtwitter 404s.
    let screenName: string;
    try {
      screenName = decodeURIComponent(m[1]!);
    } catch {
      screenName = m[1]!;
    }
    return { screenName, statusId: m[2]! };
  } catch {
    return null;
  }
}

/** Detect — used by extract.ts to decide whether to dispatch here. */
export function isXUrl(rawUrl: string): boolean {
  return parseTweetUrl(rawUrl) !== null;
}

export async function extractFromX(rawUrl: string): Promise<ExtractResult> {
  const parsed = parseTweetUrl(rawUrl);
  if (!parsed) throw new Error("not an x.com / twitter.com URL");

  const apiUrl = `${FXTWITTER_BASE}/${encodeURIComponent(parsed.screenName)}/status/${parsed.statusId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Glean/1.0 (+https://github.com/; extractor)",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`fxtwitter fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`fxtwitter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as FxResponse;
  if (data.code !== 200 || !data.tweet) {
    throw new Error(`fxtwitter returned code ${data.code}: ${data.message ?? "no tweet"}`);
  }

  const tweet = data.tweet;
  const body = tweet.article ? articleToBody(tweet) : tweetToBody(tweet);
  if (!body.text || body.text.length < 100) {
    throw new Error(
      `tweet body too short to process (${body.text.length} chars). ` +
        `If this is a thread or media-only post, paste content manually instead.`,
    );
  }
  return {
    title: body.title,
    textContent: body.text,
    detectedLang: detectLang(body.text),
    truncated: false,
  };
}

/** ---- X Article (DraftJS) → text + inline image markdown ---- */
function articleToBody(tweet: FxTweet): { title: string; text: string } {
  const art = tweet.article!;
  const entitiesByKey = new Map<string, FxEntity>();
  for (const e of art.content?.entityMap ?? []) entitiesByKey.set(String(e.key), e.value);
  const mediaById = new Map<string, FxMediaEntity>();
  for (const m of art.media_entities ?? []) mediaById.set(m.media_id, m);

  const lines: string[] = [];
  lines.push(`# ${art.title.trim()}`);
  lines.push("");
  lines.push(`By @${tweet.author?.screen_name ?? "unknown"} · ${art.created_at ?? ""}`);
  lines.push("");
  const cover = art.cover_media?.media_info?.original_img_url;
  if (cover) {
    lines.push(`![${art.title}](${cover})`);
    lines.push("");
  }

  for (const block of art.content?.blocks ?? []) {
    const t = block.type ?? "unstyled";
    const txt = (block.text ?? "").trim();
    if (t === "atomic") {
      const rendered = resolveAtomicBlock(block, entitiesByKey, mediaById);
      if (rendered) {
        lines.push(rendered);
        lines.push("");
      }
      continue;
    }
    if (!txt) continue;
    if (t === "header-one") {
      lines.push(`# ${txt}`);
      lines.push("");
    } else if (t === "header-two") {
      lines.push(`## ${txt}`);
      lines.push("");
    } else if (t === "header-three") {
      lines.push(`### ${txt}`);
      lines.push("");
    } else if (t === "unordered-list-item") {
      lines.push(`- ${txt}`);
    } else if (t === "ordered-list-item") {
      lines.push(`1. ${txt}`);
    } else if (t === "blockquote") {
      lines.push(`> ${txt}`);
      lines.push("");
    } else {
      lines.push(txt);
      lines.push("");
    }
  }

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: art.title.trim(), text };
}

/**
 * X Article atomic blocks reference an entity. Known entity types seen in the
 * wild:
 *   - mediaItems  → image (rendered as `![](url)`)
 *   - MARKDOWN    → raw markdown payload (prompt templates, fenced code blocks)
 *   - DIVIDER     → horizontal rule
 * Unknown types are logged once and skipped (returns null) so future X
 * additions surface in worker logs instead of silently dropping content.
 */
function resolveAtomicBlock(
  block: FxBlock,
  entitiesByKey: Map<string, FxEntity>,
  mediaById: Map<string, FxMediaEntity>,
): string | null {
  const er = block.entityRanges?.[0];
  if (!er) return null;
  const entity = entitiesByKey.get(String(er.key));
  if (!entity) return null;
  if (entity.data?.mediaItems?.[0]?.mediaId) {
    const url = mediaById.get(entity.data.mediaItems[0].mediaId)?.media_info?.original_img_url;
    return url ? `![](${url})` : null;
  }
  if (entity.type === "MARKDOWN" && entity.data?.markdown) {
    return entity.data.markdown;
  }
  if (entity.type === "DIVIDER") {
    return "---";
  }
  console.warn("extract-x: unknown atomic entity type", entity.type);
  return null;
}

/** ---- Plain tweet (no article) → text + photo markdown ---- */
function tweetToBody(tweet: FxTweet): { title: string; text: string } {
  const author = tweet.author?.name ?? tweet.author?.screen_name ?? "Unknown";
  const handle = tweet.author?.screen_name ?? "?";
  const body = tweet.text || tweet.raw_text?.text || "";
  const headline = body.replace(/\s+/g, " ").slice(0, 70).trim() || `Tweet by ${author}`;

  const lines: string[] = [];
  lines.push(`# ${headline}`);
  lines.push("");
  lines.push(`By @${handle} · ${tweet.created_at ?? ""}`);
  lines.push("");
  if (body) {
    lines.push(body);
    lines.push("");
  }
  // Inline media (photos) — fxtwitter exposes a media object on plain tweets.
  for (const photo of tweet.media?.photos ?? []) {
    if (photo.url) {
      lines.push(`![${photo.altText ?? ""}](${photo.url})`);
      lines.push("");
    }
  }
  // Quoted tweet preview, if any.
  if (tweet.quote?.text) {
    lines.push("> " + tweet.quote.text.replace(/\n/g, " "));
    lines.push(`> — @${tweet.quote.author?.screen_name ?? "?"}`);
    lines.push("");
  }

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: headline, text };
}

function detectLang(text: string): "zh" | "en" | "other" {
  const sample = text.slice(0, 500);
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > latin * 0.3) return "zh";
  if (latin > cjk * 2) return "en";
  return "other";
}

/** ---- fxtwitter response types (subset we use) ---- */
interface FxResponse {
  code: number;
  message?: string;
  tweet?: FxTweet;
}

interface FxTweet {
  text?: string;
  raw_text?: { text?: string };
  created_at?: string;
  author?: { name?: string; screen_name?: string };
  article?: FxArticle;
  media?: { photos?: { url: string; altText?: string }[] };
  quote?: { text?: string; author?: { screen_name?: string } };
}

interface FxArticle {
  title: string;
  created_at?: string;
  cover_media?: { media_info?: { original_img_url?: string } };
  content?: {
    blocks?: FxBlock[];
    entityMap?: { key: string | number; value: FxEntity }[];
  };
  media_entities?: FxMediaEntity[];
}

interface FxBlock {
  type?: string;
  text?: string;
  entityRanges?: { key: number | string; offset?: number; length?: number }[];
}

interface FxEntity {
  type?: string;
  data?: {
    mediaItems?: { mediaId?: string }[];
    markdown?: string;
  };
}

interface FxMediaEntity {
  media_id: string;
  media_info?: { original_img_url?: string };
}
