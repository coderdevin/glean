/**
 * Server-side corpus + wiki health checks (the LLM-Wiki "lint" verb).
 *
 * Runs over D1 data and is surfaced on /admin/wiki. Report-only — fixing is an
 * editorial action. Structurally typed (no .astro imports) so it stays a plain
 * lib; the admin page passes searchPicks() / allTagsWithCounts() / currentWikiIndex()
 * results straight in.
 */
export interface LintFinding {
  check: string;
  slug?: string;
  detail: string;
}

interface LintPick {
  slug: string;
  title_zh: string;
  title_en: string;
  summary_zh: string;
  summary_en: string;
  source_host: string;
  tags: { slug: string }[];
  published_at: Date | null;
}
interface LintTag {
  slug: string;
  count: number;
}
interface LintWiki {
  topics: { pick_slugs: string[] }[];
  generated_at: Date | null;
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Picks missing one side of a bilingual title/summary. */
export function checkTranslations(picks: LintPick[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const p of picks) {
    const missing: string[] = [];
    if (!p.title_zh.trim()) missing.push("title_zh");
    if (!p.title_en.trim()) missing.push("title_en");
    if (!p.summary_zh.trim()) missing.push("summary_zh");
    if (!p.summary_en.trim()) missing.push("summary_en");
    if (missing.length) out.push({ check: "translation", slug: p.slug, detail: `missing ${missing.join(", ")}` });
  }
  return out;
}

/** Same source host + near-identical title across more than one pick. */
export function checkDupes(picks: LintPick[]): LintFinding[] {
  const groups = new Map<string, string[]>();
  for (const p of picks) {
    const key = `${p.source_host}|${normTitle(p.title_en || p.title_zh)}`;
    groups.set(key, [...(groups.get(key) ?? []), p.slug]);
  }
  const out: LintFinding[] = [];
  for (const [key, slugs] of groups) {
    if (slugs.length > 1) {
      out.push({ check: "duplicate", slug: slugs[0], detail: `${slugs.length} picks share host+title (${key.split("|")[0]}): ${slugs.join(", ")}` });
    }
  }
  return out;
}

/** Orphan tags (0 picks) + picks carrying tags absent from the taxonomy. */
export function checkTags(picks: LintPick[], tags: LintTag[]): LintFinding[] {
  const out: LintFinding[] = [];
  const known = new Set(tags.map((t) => t.slug));
  for (const t of tags) {
    if (t.count === 0) out.push({ check: "orphan-tag", slug: t.slug, detail: "tag has 0 published picks" });
  }
  for (const p of picks) {
    for (const tg of p.tags) {
      if (!known.has(tg.slug)) out.push({ check: "unknown-tag", slug: p.slug, detail: `tag '${tg.slug}' not in taxonomy` });
    }
  }
  return out;
}

/** Wiki-health: coverage gaps, dead cross-links, staleness vs the last rebuild. */
export function checkWiki(picks: LintPick[], wiki: LintWiki | null): LintFinding[] {
  if (!wiki) return [{ check: "wiki", detail: "no wiki index built yet — rebuild it" }];
  const out: LintFinding[] = [];
  const pickSlugs = new Set(picks.map((p) => p.slug));
  const referenced = new Set(wiki.topics.flatMap((t) => t.pick_slugs));

  for (const p of picks) {
    if (!referenced.has(p.slug)) out.push({ check: "wiki-gap", slug: p.slug, detail: "published pick not in any wiki topic" });
  }
  for (const slug of referenced) {
    if (!pickSlugs.has(slug)) out.push({ check: "wiki-dead-link", slug, detail: "wiki references a slug that is not a published pick" });
  }
  if (wiki.generated_at) {
    const cutoff = wiki.generated_at.getTime();
    for (const p of picks) {
      if (p.published_at && p.published_at.getTime() > cutoff) {
        out.push({ check: "wiki-stale", slug: p.slug, detail: "published after the last wiki rebuild" });
      }
    }
  }
  return out;
}

export function lintAll(picks: LintPick[], tags: LintTag[], wiki: LintWiki | null): LintFinding[] {
  return [
    ...checkTranslations(picks),
    ...checkDupes(picks),
    ...checkTags(picks, tags),
    ...checkWiki(picks, wiki),
  ];
}
