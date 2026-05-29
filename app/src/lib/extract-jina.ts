/**
 * Jina Reader fallback. Used when Readability + linkedom can't produce a
 * usable article body — typically client-rendered SPAs (Substack, Notion,
 * Linear blog), heavy Webflow/Vercel templates, or sites that gate static
 * HTML behind a JS shell.
 *
 * Endpoint:
 *   GET https://r.jina.ai/<original-url>
 *   Accept: application/json
 *
 * Returns clean markdown (paragraphs + images as `![alt](url)`) — already
 * the shape the downstream LLM prompt expects.
 *
 * No API key required. Anonymous tier is rate-limited (~20 req/min), which
 * is fine for Glean (manual submissions). Bump rate via `JINA_API_KEY` env
 * if it ever becomes a constraint.
 */
import type { ExtractResult } from "./extract";

const JINA_BASE = "https://r.jina.ai/";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 200_000;

interface JinaResponse {
  code?: number;
  status?: number;
  data?: {
    title?: string;
    url?: string;
    content?: string;
    description?: string;
  };
  message?: string;
}

export async function extractViaJina(url: string, env?: { JINA_API_KEY?: string }): Promise<ExtractResult> {
  // Defensive: r.jina.ai expects a normal http(s) URL. Reject anything
  // exotic (file://, javascript:, data:) before forwarding.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`jina reader: invalid URL: ${url.slice(0, 80)}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`jina reader: only http(s) URLs supported, got ${parsedUrl.protocol}`);
  }
  const target = `${JINA_BASE}${parsedUrl.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = {
    accept: "application/json",
    // Ask Jina to keep images inline in markdown rather than collapse to
    // a separate "image summary" — we want them anchored in paragraphs.
    "x-return-format": "markdown",
    "x-with-images-summary": "false",
  };
  if (env?.JINA_API_KEY) headers.authorization = `Bearer ${env.JINA_API_KEY}`;

  let res: Response;
  try {
    res = await fetch(target, { signal: ctrl.signal, headers });
  } catch (err) {
    clearTimeout(timer);
    const msg = (err as Error).message || String(err);
    if (msg.toLowerCase().includes("abort")) {
      throw new Error(`jina reader timed out after ${(FETCH_TIMEOUT_MS / 1000) | 0}s`);
    }
    throw new Error(`jina reader fetch failed: ${msg.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("jina reader rate-limited (anonymous tier 20 req/min) — try again in a minute or set JINA_API_KEY");
    }
    throw new Error(`jina reader ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as JinaResponse;
  const body = data.data?.content?.trim() ?? "";
  if (!body || body.length < 200) {
    throw new Error(`jina reader returned too-short body (${body.length} chars)`);
  }
  const title = (data.data?.title || "").trim();
  const text = body.slice(0, MAX_BODY_BYTES);
  return {
    title,
    textContent: text,
    detectedLang: detectLang(text),
    truncated: body.length > MAX_BODY_BYTES,
  };
}

function detectLang(text: string): "zh" | "en" | "other" {
  const sample = text.slice(0, 500);
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > latin * 0.3) return "zh";
  if (latin > cjk * 2) return "en";
  return "other";
}
