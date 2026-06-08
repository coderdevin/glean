import type { APIRoute } from "astro";
import { db } from "~/db/client";
import { searchPicks, PICKS_DEFAULT_LIMIT, PICKS_MAX_LIMIT } from "~/lib/queries";

export const prerender = false;

type PickResult = Awaited<ReturnType<typeof searchPicks>>[number];

// Public, read-only index of published picks. Exposes only data already public
// on the homepage / daily / tag pages — no submission internals. Powers the
// CLI `query` command and the index step of `ask`. CDN-cached with a short
// s-maxage (same posture as the RSS feeds); no KV layer to invalidate.
function json(body: unknown, status: number, cache?: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (cache) headers["cache-control"] = cache;
  else headers["cache-control"] = "no-store";
  return new Response(JSON.stringify(body), { status, headers });
}

const CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

function toIndexItem(p: PickResult) {
  return {
    slug: p.slug,
    title_zh: p.title_zh,
    title_en: p.title_en,
    summary_zh: p.summary_zh,
    summary_en: p.summary_en,
    category: p.category,
    tags: p.tags.map((t: { slug: string }) => t.slug),
    source_url: p.source_url,
    source_host: p.source_host,
    read_minutes: p.read_minutes,
    published_at: p.published_at,
  };
}

export const GET: APIRoute = async (ctx) => {
  const sp = ctx.url.searchParams;
  const date = sp.get("date") ?? undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad_date" }, 400);

  // Resolve the effective page size here (mirroring searchPicks's clamp) so the
  // next_offset math agrees with what was actually returned — otherwise a caller
  // that omits ?limit gets the 50 default but next_offset would read as null.
  const reqLimit = numParam(sp.get("limit"));
  const limit = Math.min(Math.max(reqLimit ?? PICKS_DEFAULT_LIMIT, 1), PICKS_MAX_LIMIT);
  const offset = numParam(sp.get("offset")) ?? numParam(sp.get("cursor")) ?? 0;

  const env = ctx.locals.runtime.env;
  const rows = await searchPicks(db(env.DB), {
    q: sp.get("q") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    category: sp.get("category") ?? undefined,
    date,
    limit,
    offset,
  });

  const items = rows.map(toIndexItem);
  const next = items.length === limit ? offset + limit : null;
  return json({ count: items.length, items, next_offset: next }, 200, CACHE);
};

function numParam(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
