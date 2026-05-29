/**
 * KV-backed read-through cache for SSR HTML / API payloads.
 *
 * Pattern: `cacheOrCompute(kv, key, ttl, compute)`. On miss we run compute,
 * stash the value, and return it. On publish/reject/save the admin handlers
 * call `bust(kv, keys)` with the affected keys.
 *
 * Values are stored as strings (already-serialized JSON or HTML). The KV
 * `expirationTtl` is the same as the TTL passed in.
 */

export async function cacheOrCompute(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<string>,
): Promise<{ value: string; hit: boolean }> {
  const cached = await kv.get(key);
  if (cached !== null) return { value: cached, hit: true };
  const fresh = await compute();
  await kv.put(key, fresh, { expirationTtl: ttlSeconds });
  return { value: fresh, hit: false };
}

export async function bust(kv: KVNamespace, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => kv.delete(k)));
}

/** Cache-key helpers — colocated so callers + busters use the same strings. */
export const cacheKeys = {
  home: (lang: "zh" | "en") => `v1:home:${lang}`,
  daily: (date: string, lang: "zh" | "en") => `v1:daily:${date}:${lang}`,
  weeklyArchive: (lang: "zh" | "en") => `v1:weekly:archive:${lang}`,
  weeklyIssue: (n: number, lang: "zh" | "en") => `v1:weekly:${n}:${lang}`,
  tag: (slug: string, lang: "zh" | "en") => `v1:tag:${slug}:${lang}`,
  pick: (slug: string, lang: "zh" | "en") => `v1:pick:${slug}:${lang}`,
  rssDaily: (lang: "zh" | "en") => `v1:rss:daily:${lang}`,
  rssWeekly: (lang: "zh" | "en") => `v1:rss:weekly:${lang}`,
};

/** Best-effort fan-out bust on publish / depublish of a single pick. */
export async function bustForPick(
  kv: KVNamespace,
  pick: { slug: string; dailyDate: string; weeklyIssueId: string | null },
  tagSlugs: string[],
): Promise<void> {
  const langs: ("zh" | "en")[] = ["zh", "en"];
  const keys: string[] = [];
  for (const lang of langs) {
    keys.push(cacheKeys.home(lang));
    keys.push(cacheKeys.daily(pick.dailyDate, lang));
    keys.push(cacheKeys.pick(pick.slug, lang));
    keys.push(cacheKeys.rssDaily(lang));
    keys.push(cacheKeys.rssWeekly(lang));
    keys.push(cacheKeys.weeklyArchive(lang));
    if (pick.weeklyIssueId) {
      // weeklyIssueId is the ULID; the cache key uses the issue number, so we
      // skip targeted bust here and rely on the archive bust above plus the
      // 24h TTL on issue pages.
    }
    for (const slug of tagSlugs) keys.push(cacheKeys.tag(slug, lang));
  }
  await bust(kv, keys);
}

/** Fan-out bust on weekly issue generate / save / publish / unpublish / delete. */
export async function bustForWeekly(
  kv: KVNamespace,
  issue: { number: number },
): Promise<void> {
  const langs: ("zh" | "en")[] = ["zh", "en"];
  const keys: string[] = [];
  for (const lang of langs) {
    keys.push(cacheKeys.home(lang));
    keys.push(cacheKeys.weeklyArchive(lang));
    keys.push(cacheKeys.weeklyIssue(issue.number, lang));
    keys.push(cacheKeys.rssWeekly(lang));
  }
  await bust(kv, keys);
}
