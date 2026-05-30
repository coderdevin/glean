/**
 * GitHub repository extractor.
 *
 * A repo landing page (github.com/<owner>/<repo>) is a client-rendered SPA —
 * `fetch(url)` returns mostly chrome (file list, nav, star/fork buttons) with
 * the README buried in noise. Readability + Jina both produce low-quality
 * bodies. So, like extract-x.ts, we go to the source API instead.
 *
 * We assemble a rich "understand the repo" document from three GitHub REST
 * calls and hand it to the LLM stage, which (via the GitHub-specific prompts
 * selected by sourceHost in llm.ts) writes an *explainer article* about the
 * project rather than a verbatim README translation:
 *
 *   GET /repos/{owner}/{repo}            → metadata (desc, language, stars…)
 *   GET /repos/{owner}/{repo}/readme     → raw README markdown
 *   GET /repos/{owner}/{repo}/git/trees  → file tree → structure overview
 *
 * Unauthenticated GitHub API is 60 req/hour per IP (shared across the Worker),
 * so a GITHUB_TOKEN (→ 5000 req/hour) is strongly recommended in production.
 */
import type { ExtractResult } from "./extract";
import { detectLang } from "./lang";

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 200_000;
const MAX_TREE_ENTRIES = 80;

/** First path segment values that are GitHub site routes, not repo owners. */
const RESERVED_OWNERS = new Set([
  "features", "about", "pricing", "marketplace", "sponsors", "settings",
  "login", "logout", "join", "signup", "explore", "topics", "trending",
  "collections", "events", "notifications", "new", "organizations", "orgs",
  "apps", "contact", "site", "security", "readme", "dashboard", "search",
  "codespaces", "stars", "watching", "issues", "pulls", "account",
  "support", "enterprise", "team",
]);

/** Lowercase host with a leading `www.` stripped — GitHub serves both. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Parse github.com/<owner>/<repo>[/...] → { owner, repo }. Deeper paths
 *  (/tree/main, /blob/..., ?tab=...) all resolve to the same repo root. */
export function parseRepoUrl(rawUrl: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(rawUrl);
    if (bareHost(u.host) !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = decodeURIComponent(parts[0]!);
    let repo = decodeURIComponent(parts[1]!);
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    // Strip a trailing .git (clone URLs pasted into the form).
    repo = repo.replace(/\.git$/i, "");
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/** Detect — used by extract.ts to decide whether to dispatch here. */
export function isGithubRepoUrl(rawUrl: string): boolean {
  return parseRepoUrl(rawUrl) !== null;
}

/** Shared with llm.ts so the GitHub-specific prompts are selected for the
 *  same set of submissions this extractor handles. */
export function isGithubHost(host?: string): boolean {
  if (!host) return false;
  return bareHost(host) === "github.com";
}

interface RepoMeta {
  description?: string;
  language?: string;
  stargazers_count?: number;
  topics?: string[];
  license?: { spdx_id?: string; name?: string } | null;
  homepage?: string;
  default_branch?: string;
  pushed_at?: string;
  full_name?: string;
}

interface TreeResponse {
  tree?: { path?: string; type?: string }[];
  truncated?: boolean;
}

export async function extractFromGithub(
  rawUrl: string,
  opts?: { githubToken?: string },
): Promise<ExtractResult> {
  const parsed = parseRepoUrl(rawUrl);
  if (!parsed) throw new Error("not a github.com repository URL");
  const { owner, repo } = parsed;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "Glean/1.0 (+https://github.com/coderdevin/glean; extractor)",
    "x-github-api-version": "2022-11-28",
  };
  if (opts?.githubToken) headers.authorization = `Bearer ${opts.githubToken}`;

  // README doesn't need the default branch (GitHub resolves it), so fetch it
  // concurrently with metadata instead of after. Metadata is still awaited
  // first because the tree request needs default_branch. README is best-effort
  // (a repo can lack one) so it carries its own .catch.
  const metaPromise = ghJson<RepoMeta>(`${GITHUB_API}/repos/${owner}/${repo}`, headers);
  const readmePromise = ghReadme(owner, repo, headers).catch(() => "");

  const meta = await metaPromise;
  const branch = meta.default_branch || "main";

  // File tree (best-effort — a huge repo's tree may 404 or truncate).
  const [readme, tree] = await Promise.all([
    readmePromise,
    ghJson<TreeResponse>(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      headers,
    ).catch(() => ({ tree: [] }) as TreeResponse),
  ]);

  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`;
  const body = assembleBody({ owner, repo, meta, readme, tree, rawBase });

  if (body.length < 200) {
    throw new Error(
      `GitHub repo ${owner}/${repo} has no usable README — paste content manually instead`,
    );
  }

  const text = body.slice(0, MAX_BODY_BYTES);
  return {
    title: meta.full_name || `${owner}/${repo}`,
    textContent: text,
    detectedLang: detectLang(text),
    truncated: body.length > MAX_BODY_BYTES,
  };
}

/** Build the markdown document the LLM stage reads: metadata header +
 *  structure overview + README body (with relative links absolutized). */
function assembleBody(args: {
  owner: string;
  repo: string;
  meta: RepoMeta;
  readme: string;
  tree: TreeResponse;
  rawBase: string;
}): string {
  const { owner, repo, meta, readme, tree, rawBase } = args;
  const lines: string[] = [];

  lines.push(`# GitHub repository: ${owner}/${repo}`);
  lines.push("");
  if (meta.description) lines.push(`> ${meta.description.trim()}`);
  const facts: string[] = [];
  if (meta.language) facts.push(`Primary language: ${meta.language}`);
  if (typeof meta.stargazers_count === "number") facts.push(`Stars: ${meta.stargazers_count}`);
  if (meta.topics?.length) facts.push(`Topics: ${meta.topics.join(", ")}`);
  const lic = meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION"
    ? meta.license.spdx_id
    : meta.license?.name;
  if (lic) facts.push(`License: ${lic}`);
  if (meta.homepage?.trim()) facts.push(`Homepage: ${meta.homepage.trim()}`);
  if (facts.length) {
    lines.push("");
    for (const f of facts) lines.push(`- ${f}`);
  }

  const structure = summarizeTree(tree);
  if (structure) {
    lines.push("");
    lines.push("## Repository structure");
    lines.push("");
    lines.push("```");
    lines.push(structure);
    lines.push("```");
  }

  if (readme.trim()) {
    lines.push("");
    lines.push("## README");
    lines.push("");
    lines.push(absolutizeMarkdown(readme.trim(), rawBase));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Compact the recursive file tree into a readable overview: top-level dirs
 *  and shallow notable files, capped so we don't blow the body budget. */
function summarizeTree(tree: TreeResponse): string {
  const all = (tree.tree ?? [])
    .filter((e) => e.path && e.path.split("/").length <= 2) // top 2 levels only
    .map((e) => (e.type === "tree" ? `${e.path}/` : (e.path as string)))
    .sort();
  // Sort first, then cap — so the overview is the canonical first N paths, not
  // whatever N happened to come first in GitHub's tree ordering.
  const truncated = tree.truncated || all.length > MAX_TREE_ENTRIES;
  const entries = all.slice(0, MAX_TREE_ENTRIES);
  if (!entries.length) return "";
  return entries.join("\n") + (truncated ? "\n… (tree truncated)" : "");
}

/** Rewrite relative markdown image/link targets to absolute raw.githubusercontent
 *  URLs so the downstream pipeline (which preserves `![alt](url)`) gets working
 *  image links. Absolute URLs and anchors are left untouched. */
function absolutizeMarkdown(md: string, rawBase: string): string {
  return md.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g, (full, label: string, target: string) => {
    const t = target.trim();
    if (/^(https?:|mailto:|#|data:)/i.test(t)) return full;
    try {
      // new URL() resolves "./foo" against the base on its own.
      return `${label}(${new URL(t, rawBase).toString()})`;
    } catch {
      return full;
    }
  });
}

async function ghJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await ghFetch(url, headers);
  return (await res.json()) as T;
}

/** README via the raw media type → plain markdown text (no base64 decode). */
async function ghReadme(
  owner: string,
  repo: string,
  headers: Record<string, string>,
): Promise<string> {
  const res = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
    ...headers,
    accept: "application/vnd.github.raw+json",
  });
  return await res.text();
}

async function ghFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (msg.toLowerCase().includes("abort")) {
      throw new Error(`github api timed out after ${(FETCH_TIMEOUT_MS / 1000) | 0}s`);
    }
    throw new Error(`github api fetch failed: ${msg.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const hint = !headers.authorization
      ? " — set GITHUB_TOKEN to raise the 60 req/hour anonymous limit to 5000"
      : "";
    throw new Error(
      `github api ${res.status} (rate limit, remaining=${remaining ?? "?"})${hint}`,
    );
  }
  if (!res.ok) {
    throw new Error(`github api ${res.status} from ${new URL(url).pathname}`);
  }
  return res;
}

