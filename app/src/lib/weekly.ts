/**
 * Pure helpers for assembling a weekly issue. No I/O — unit-tested via
 * scripts/weekly-*.test.ts (run with `npx tsx`). Relative import (not the `~`
 * alias) keeps this module resolvable when the tests run under tsx.
 */
import { formatDateISO } from "./datetime";

export interface WeekRange {
  dateStart: string; // YYYY-MM-DD (inclusive, Monday)
  dateEnd: string; //   YYYY-MM-DD (inclusive, Sunday)
}

/** Add `days` to a YYYY-MM-DD string, returning a YYYY-MM-DD string (UTC math). */
function addDays(isoDate: string, days: number): string {
  const t = Date.parse(isoDate + "T00:00:00Z") + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The current week so far: this week's Monday → today (editorial tz). Used as
 * the editable default when generating an issue mid-week — `dateEnd` is today
 * (not Sunday) so the range never claims dates that haven't happened yet.
 */
export function thisWeekToDate(now: Date, tz: string): WeekRange {
  const today = formatDateISO(now, tz);
  const dow = new Date(today + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0..Sun=6
  return { dateStart: addDays(today, -daysSinceMonday), dateEnd: today };
}

export interface LayoutSection {
  heading_zh: string;
  heading_en: string;
  pick_ids: string[];
}

interface WeeklyDraftish {
  sections?: { heading_zh?: string; heading_en?: string; pick_ids?: string[] }[];
}

/**
 * Reconcile raw AI output into a valid layout against the allowed pick set:
 *  - drop unknown pick_ids,
 *  - dedup (a pick appears at most once, first occurrence wins),
 *  - drop sections left empty after cleanup,
 *  - append any allowed pick the AI omitted into a trailing "其他 · More".
 * Never silently loses a pick; never duplicates one.
 */
export function repairWeeklyDraft(ai: WeeklyDraftish, allowedPickIds: string[]): LayoutSection[] {
  const allowed = new Set(allowedPickIds);
  const used = new Set<string>();
  const sections: LayoutSection[] = [];

  for (const s of ai.sections ?? []) {
    const ids: string[] = [];
    for (const id of s.pick_ids ?? []) {
      if (allowed.has(id) && !used.has(id)) {
        used.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) continue;
    sections.push({
      heading_zh: (s.heading_zh ?? "").trim() || "未命名",
      heading_en: (s.heading_en ?? "").trim() || "Untitled",
      pick_ids: ids,
    });
  }

  const leftover = allowedPickIds.filter((id) => !used.has(id));
  if (leftover.length > 0) {
    sections.push({ heading_zh: "其他", heading_en: "More", pick_ids: leftover });
  }
  return sections;
}

/**
 * Given the current layout and the set of pick ids previously linked to the
 * issue, compute which picks to link (set weekly_issue_id) and which to unlink
 * (clear weekly_issue_id because the editor removed them from the layout).
 */
export function reconcileLayout(
  layout: LayoutSection[],
  previouslyLinkedIds: string[],
): { linkIds: string[]; unlinkIds: string[] } {
  const linkIds = layout.flatMap((s) => s.pick_ids);
  const inLayout = new Set(linkIds);
  const unlinkIds = previouslyLinkedIds.filter((id) => !inLayout.has(id));
  return { linkIds, unlinkIds };
}

export interface WeeklyGroup<P> {
  zh: string;
  en: string;
  picks: P[];
}

/**
 * Group picks into themed sections in layout order, mapping each pick by id.
 * Picks present in the issue but absent from the layout (defensive) fall into a
 * trailing "其他 · More" group so nothing silently disappears. Shared by the
 * public issue page and the weekly email render so they never drift.
 */
export function buildWeeklyGroups<P extends { id: string }>(
  layout: LayoutSection[],
  picks: P[],
): WeeklyGroup<P>[] {
  const byId = new Map(picks.map((p) => [p.id, p]));
  const groups: WeeklyGroup<P>[] = [];
  const seen = new Set<string>();
  for (const sec of layout) {
    const list = sec.pick_ids.map((id) => byId.get(id)).filter((p): p is P => Boolean(p));
    list.forEach((p) => seen.add(p.id));
    if (list.length > 0) groups.push({ zh: sec.heading_zh, en: sec.heading_en, picks: list });
  }
  const leftover = picks.filter((p) => !seen.has(p.id));
  if (leftover.length > 0) groups.push({ zh: "其他", en: "More", picks: leftover });
  return groups;
}
