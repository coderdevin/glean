/**
 * Shared display formatting for weekly issues so the homepage cover, the
 * archive list, and the issue masthead never drift (they used to show #01 vs
 * 001, `5/25 – 5/31, 2026` vs `2026-05-25 → 2026-05-31`, etc.).
 */

/** Zero-padded issue number, e.g. 1 → "#001". */
export const issueNo = (n: number): string => `#${String(n).padStart(3, "0")}`;

/**
 * Compact date range: "5/25–5/31" within one year, "12/30 2025–1/5 2026"
 * across years. Inputs are YYYY-MM-DD, parsed as UTC to avoid TZ drift.
 */
export function weeklyDateRange(start: string, end: string): string {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${start} – ${end}`;
  const md = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return s.getUTCFullYear() === e.getUTCFullYear()
    ? `${md(s)}–${md(e)}`
    : `${md(s)} ${s.getUTCFullYear()}–${md(e)} ${e.getUTCFullYear()}`;
}

/**
 * Friendly total read time: minutes under an hour, rounded hours above. A bare
 * "约 520 分钟" reads worse than "约 9 小时" for a full digest issue.
 */
export function weeklyReadDuration(totalMin: number): { zh: string; en: string } {
  if (totalMin <= 0) return { zh: "", en: "" };
  if (totalMin < 60) return { zh: `约 ${totalMin} 分钟`, en: `~${totalMin} min` };
  const h = Math.round(totalMin / 60);
  return { zh: `约 ${h} 小时`, en: `~${h} hr` };
}
