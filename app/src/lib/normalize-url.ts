/**
 * Normalize URLs for dedup. Stored as `submissions.url` and `picks.source_url`.
 *
 * Rules (intentionally minimal — over-aggressive stripping breaks legit URLs):
 *   - lowercase protocol + host
 *   - collapse known host aliases (x.com ↔ twitter.com, m./mobile. → bare host)
 *   - drop fragment
 *   - drop trailing slash on path (except root)
 *   - drop known tracking params (utm_*, fbclid, gclid, ref_src, share_*, spm,
 *     and Twitter's "s" / "t")
 *   - collapse github.com/<owner>/<repo>/... to the repo root (the extractor
 *     treats deep paths as the repo anyway, so /tree, /blob, ?tab=… dedup)
 *   - leave the rest of the query string alone
 */

import { parseRepoUrl } from "./extract-github";

const HOST_ALIASES: Record<string, string> = {
  "twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "m.twitter.com": "x.com",
  "www.x.com": "x.com",
  "mobile.x.com": "x.com",
  "www.youtube.com": "youtube.com",
  "m.youtube.com": "youtube.com",
  "www.github.com": "github.com",
};

const DROP_PARAMS = new Set([
  "fbclid",
  "gclid",
  "ref_src",
  "ref_url",
  "ref",
  "share_source",
  "share_medium",
  "share_plat",
  "share_id",
  "spm",
  "s",
  "t",
]);

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  u.protocol = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  u.hostname = HOST_ALIASES[host] ?? host;
  // Collapse a GitHub repo URL to its canonical root so deep links
  // (/tree/main, /blob/…, ?tab=readme-ov-file) dedup against the bare repo.
  const repo = parseRepoUrl(trimmed);
  if (repo) {
    u.pathname = `/${repo.owner}/${repo.repo}`;
    u.search = "";
  }
  for (const k of [...u.searchParams.keys()]) {
    if (DROP_PARAMS.has(k) || k.toLowerCase().startsWith("utm_")) {
      u.searchParams.delete(k);
    }
  }
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}
