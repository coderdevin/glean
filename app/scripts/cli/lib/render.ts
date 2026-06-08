/** Human-readable terminal formatting. Pure string helpers, unit-tested. */
import type { PickIndexItem, Pick, StatusView, WikiTopic } from "./api";

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/** A simple left-aligned column table. */
export function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const fmt = (r: string[]) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ").trimEnd();
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}

const PIPELINE = ["pending", "analyzing", "composing", "ready"];

export function renderStatus(id: string, v: StatusView): string {
  const idx = v.stepIndex ?? -1;
  const steps = PIPELINE.map((s, i) => {
    const done = idx > i && idx >= 0;
    const mark = v.status === s ? "►" : done ? "✓" : "·";
    return `${mark} ${s}`;
  }).join("   ");
  const lines = [
    `${id}`,
    `status: ${v.status}${v.isTerminal ? " (terminal)" : ""}`,
    steps,
  ];
  if (v.headline) lines.push(`\n${v.headline.en}`);
  if (v.sub) lines.push(`${v.sub.en}`);
  if (v.hasPick) lines.push(`\npublished → read it with: glean read <slug>`);
  return lines.join("\n");
}

export function renderPicksTable(items: PickIndexItem[], lang: "zh" | "en"): string {
  if (items.length === 0) return "(no matching picks)";
  const rows = items.map((p) => [
    p.slug,
    truncate(lang === "en" ? p.title_en : p.title_zh, 50),
    truncate(p.tags.join(","), 24),
    (p.published_at ?? "").toString().slice(0, 10),
  ]);
  return table(rows, ["slug", "title", "tags", "published"]);
}

/** Topics whose title or blurb (either language) contains the query, case-insensitive. */
export function filterTopics(topics: WikiTopic[], q: string | undefined): WikiTopic[] {
  const needle = q?.trim().toLowerCase();
  if (!needle) return topics;
  return topics.filter((t) =>
    [t.title_zh, t.title_en, t.blurb_zh, t.blurb_en].some((s) => s.toLowerCase().includes(needle)),
  );
}

export function renderWikiTopics(topics: WikiTopic[], lang: "zh" | "en"): string {
  if (topics.length === 0) return "";
  return topics
    .map((t) => {
      const title = lang === "en" ? t.title_en : t.title_zh;
      const blurb = lang === "en" ? t.blurb_en : t.blurb_zh;
      return `▸ ${title}  (${t.pick_slugs.length})${blurb ? `\n  ${truncate(blurb, 76)}` : ""}`;
    })
    .join("\n");
}

export function renderPick(p: Pick, lang: "zh" | "en" | "both"): string {
  const out: string[] = [];
  const both = lang === "both";
  if (both || lang === "zh") out.push(`# ${p.title_zh}`);
  if (both || lang === "en") out.push(both ? `  ${p.title_en}` : `# ${p.title_en}`);
  out.push(`\n${p.source_url}  ·  ${p.read_minutes ?? "?"} min  ·  ${p.category ?? ""}`);
  if (p.tags?.length) out.push(`tags: ${p.tags.map((t) => t.slug).join(", ")}`);
  out.push("");
  if (both || lang === "zh") out.push(p.summary_zh);
  if (both || lang === "en") out.push(p.summary_en);

  for (const s of p.sections ?? []) {
    out.push("");
    if ((both || lang === "zh") && s.heading_zh) out.push(`## ${s.heading_zh}`);
    if ((both || lang === "en") && s.heading_en) out.push(both ? `   ${s.heading_en}` : `## ${s.heading_en}`);
    if ((both || lang === "zh") && s.body_zh) out.push(s.body_zh);
    if ((both || lang === "en") && s.body_en) out.push(s.body_en);
  }
  return out.join("\n");
}

export interface Finding {
  check: string;
  slug?: string;
  detail: string;
}

export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "✓ no issues found";
  const rows = findings.map((f) => [f.check, f.slug ?? "—", truncate(f.detail, 70)]);
  return table(rows, ["check", "slug", "detail"]) + `\n\n${findings.length} issue(s)`;
}
