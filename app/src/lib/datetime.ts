/**
 * Timezone-aware formatting helpers.
 *
 * All user-facing dates/times go through here so the publication has a
 * consistent editorial timezone (instead of leaking UTC into the UI).
 *
 * The timezone is set via the `SITE_TZ` env (an IANA name like
 * "Asia/Shanghai", "America/New_York"). Default: "Asia/Shanghai" — the
 * primary audience is Chinese. Forks should override in wrangler.toml.
 */

const DEFAULT_TZ = "Asia/Shanghai";

export function siteTz(env: { SITE_TZ?: string } | undefined): string {
  return env?.SITE_TZ?.trim() || DEFAULT_TZ;
}

/** "HH:MM" in the site's editorial timezone. Returns "" for null input. */
export function formatTimeHM(d: Date | string | null, tz: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "HH:MM:SS" in the site's editorial timezone. Returns "" for null input. */
export function formatTimeHMS(d: Date | string | null, tz: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** "YYYY-MM-DD" in the site's editorial timezone. Returns "" for null input. */
export function formatDateISO(d: Date | string | null, tz: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  // en-CA's short date format is YYYY-MM-DD — convenient ISO-shaped output.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Today's date in YYYY-MM-DD form, in the site's editorial timezone. */
export function todayInSiteTz(tz: string): string {
  return formatDateISO(new Date(), tz);
}
