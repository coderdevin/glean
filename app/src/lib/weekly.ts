/**
 * Pure helpers for assembling a weekly issue. No I/O — unit-tested via
 * scripts/weekly-*.test.ts (run with `npx tsx`).
 */

export interface WeekRange {
  dateStart: string; // YYYY-MM-DD (inclusive, Monday)
  dateEnd: string; //   YYYY-MM-DD (inclusive, Sunday)
}

/** YYYY-MM-DD for an instant in a given IANA timezone (en-CA → ISO-shaped). */
function isoDateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Add `days` to a YYYY-MM-DD string, returning a YYYY-MM-DD string (UTC math). */
function addDays(isoDate: string, days: number): string {
  const t = Date.parse(isoDate + "T00:00:00Z") + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Last complete Monday→Sunday week, relative to `now` in the editorial tz.
 * "Last week" = the full week immediately before the week `now` falls in.
 */
export function lastWeekRange(now: Date, tz: string): WeekRange {
  const today = isoDateInTz(now, tz); // local calendar date
  const dow = new Date(today + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0..Sun=6
  const thisMonday = addDays(today, -daysSinceMonday);
  const lastMonday = addDays(thisMonday, -7);
  return { dateStart: lastMonday, dateEnd: addDays(lastMonday, 6) };
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
