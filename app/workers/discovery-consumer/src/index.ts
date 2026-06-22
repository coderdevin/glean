/**
 * Glean discovery worker.
 *
 * scheduled() (cron, twice daily): pull candidates from RSS/HN/arXiv, dedup,
 * gate-1 prescore, and enqueue survivors to glean-ingest — feeding the SAME
 * pipeline /api/submit uses. Each adapter runs under its own try/catch so one
 * dead feed can't sink the run.
 *
 * fetch() POST /run : dev-only manual trigger (Pages/wrangler proxy).
 */
import { runDiscovery, parseFeed, parseHnHits, parseArxivXml, type Candidate, type DiscoveryEnv } from "../../../src/lib/discovery";
import { FEEDS, HN, ARXIV } from "./sources";

export interface Env extends DiscoveryEnv {}

async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, { headers: { accept, "user-agent": "glean-discovery/1.0" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function collect(): Promise<Candidate[]> {
  const all: Candidate[] = [];

  for (const feed of FEEDS) {
    try {
      const xml = await fetchText(feed.url, "application/rss+xml, application/atom+xml, application/xml");
      all.push(...parseFeed(xml, feed.id));
    } catch (err) {
      console.error("discovery feed fail", feed.id, (err as Error).message);
    }
  }

  try {
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=${HN.hitsPerPage}&numericFilters=points>=${HN.minPoints}`;
    const json = JSON.parse(await fetchText(url, "application/json")) as { hits?: unknown[] };
    all.push(...parseHnHits(json as never, HN.minPoints));
  } catch (err) {
    console.error("discovery hn fail", (err as Error).message);
  }

  for (const cat of ARXIV.categories) {
    try {
      const url = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}&sortBy=submittedDate&sortOrder=descending&max_results=${ARXIV.maxResults}`;
      all.push(...parseArxivXml(await fetchText(url, "application/atom+xml")));
    } catch (err) {
      console.error("discovery arxiv fail", cat, (err as Error).message);
    }
  }

  return all;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`discovery tick: cron="${controller.cron}"`);
    const candidates = await collect();
    const result = await runDiscovery(env, candidates);
    console.log(`discovery done: ${JSON.stringify(result)}`);
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      const candidates = await collect();
      const result = await runDiscovery(env, candidates);
      return new Response(JSON.stringify({ ok: true, result }, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("glean-discovery worker: POST /run", { status: 200 });
  },
};
