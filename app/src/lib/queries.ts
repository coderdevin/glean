/**
 * Read queries — these run in SSR routes and are pre-shaped for the UI
 * components (ArticleCard etc) so pages don't have to do their own joins.
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "~/db/client";
import {
  pickTags,
  picks,
  tags as tagsTable,
  categories as categoriesTable,
  weeklyIssues,
  weeklyDeliveries,
  subscribers,
  articleAnnotations,
  wikiIndex,
  submissionEvents,
  type CategoryRow,
} from "~/db/schema";
import type { WikiIndexView, WikiTopic } from "./wiki";
import type { ArticleCardPick } from "~/components/ArticleCard.astro";
import type { WeeklyCoverIssue } from "~/components/WeeklyCover.astro";
import { buildWeeklyGroups, type LayoutSection } from "~/lib/weekly";

/** Compact table-of-contents for the homepage "本期目录": section heading +
 *  the article titles under it (no summaries). */
export interface WeeklyTocGroup {
  zh: string;
  en: string;
  items: { title_zh: string; title_en: string; slug: string }[];
}

interface PickRow {
  id: string;
  slug: string;
  title_zh: string;
  title_en: string;
  summary_zh: string;
  summary_en: string;
  bullets_json: string;
  editor_note_zh: string | null;
  editor_note_en: string | null;
  source_url: string;
  source_host: string;
  read_minutes: number;
  category: string;
  daily_date: string;
  weekly_issue_id: string | null;
  position_in_day: number;
  submitter_name: string | null;
  published_at: Date | null;
}

function rowsToCardPicks(
  rows: PickRow[],
  tagMap: Map<string, { slug: string; name_zh: string; name_en: string; family: string }[]>,
): ArticleCardPick[] {
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title_zh: r.title_zh,
    title_en: r.title_en,
    summary_zh: r.summary_zh,
    summary_en: r.summary_en,
    bullets: safeJson(r.bullets_json) as { zh: string; en: string }[],
    editor_note_zh: r.editor_note_zh,
    editor_note_en: r.editor_note_en,
    source_url: r.source_url,
    source_host: r.source_host,
    read_minutes: r.read_minutes,
    category: r.category,
    submitter_name: r.submitter_name,
    published_at: r.published_at,
    tags: tagMap.get(r.id) ?? [],
  }));
}

function safeJson<T>(s: string | null | undefined): T {
  if (!s) return [] as unknown as T;
  try { return JSON.parse(s) as T; } catch { return [] as unknown as T; }
}

// D1 allows at most ~100 bound parameters per statement, so every inArray()
// over a caller-sized id list must be chunked or it starts throwing the moment
// the corpus grows past the limit.
const D1_IN_CHUNK = 90;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function attachTags(
  db: DB,
  pickIds: string[],
): Promise<Map<string, { slug: string; name_zh: string; name_en: string; family: string }[]>> {
  if (pickIds.length === 0) return new Map();
  const rows = (
    await Promise.all(
      chunk(pickIds, D1_IN_CHUNK).map((ids) =>
        db
          .select({
            pick_id: pickTags.pickId,
            slug: tagsTable.slug,
            name_zh: tagsTable.nameZh,
            name_en: tagsTable.nameEn,
            family: tagsTable.family,
          })
          .from(pickTags)
          .innerJoin(tagsTable, eq(pickTags.tagSlug, tagsTable.slug))
          .where(inArray(pickTags.pickId, ids)),
      ),
    )
  ).flat();

  const map = new Map<string, { slug: string; name_zh: string; name_en: string; family: string }[]>();
  for (const r of rows) {
    const list = map.get(r.pick_id) ?? [];
    list.push({ slug: r.slug, name_zh: r.name_zh, name_en: r.name_en, family: r.family });
    map.set(r.pick_id, list);
  }
  return map;
}

async function rawPicks(
  db: DB,
  where: ReturnType<typeof and> | undefined,
  orderBy: any[],
  limit?: number,
  offset?: number,
): Promise<{ id: string; row: PickRow }[]> {
  let q = db
    .select({
      id: picks.id,
      slug: picks.slug,
      title_zh: picks.titleZh,
      title_en: picks.titleEn,
      summary_zh: picks.summaryZh,
      summary_en: picks.summaryEn,
      bullets_json: picks.bulletsJson,
      editor_note_zh: picks.editorNoteZh,
      editor_note_en: picks.editorNoteEn,
      source_url: picks.sourceUrl,
      source_host: picks.sourceHost,
      read_minutes: picks.readMinutes,
      category: picks.category,
      daily_date: picks.dailyDate,
      weekly_issue_id: picks.weeklyIssueId,
      position_in_day: picks.positionInDay,
      submitter_name: picks.submitterName,
      published_at: picks.publishedAt,
    })
    .from(picks)
    .where(where)
    .orderBy(...orderBy);
  if (limit) q = q.limit(limit) as typeof q;
  if (offset) q = q.offset(offset) as typeof q;
  const result = (await q) as PickRow[] & { id: string }[];
  return result.map((r) => ({ id: r.id, row: r }));
}

async function hydrate(db: DB, rows: { id: string; row: PickRow }[]): Promise<ArticleCardPick[]> {
  const ids = rows.map((r) => r.id);
  const tagMap = await attachTags(db, ids);
  return rowsToCardPicks(rows.map((r) => r.row), tagMap);
}

/** Today's daily picks ordered by position desc (newest first). */
export async function dailyPicksForDate(db: DB, date: string): Promise<ArticleCardPick[]> {
  const rows = await rawPicks(
    db,
    and(eq(picks.status, "published"), eq(picks.dailyDate, date)),
    [desc(picks.positionInDay)],
  );
  return hydrate(db, rows);
}

/** Most recent N daily dates that have published picks. */
export async function recentDailyDates(db: DB, limit = 30): Promise<string[]> {
  const result = await db
    .select({ d: picks.dailyDate })
    .from(picks)
    .where(eq(picks.status, "published"))
    .groupBy(picks.dailyDate)
    .orderBy(desc(picks.dailyDate))
    .limit(limit);
  return result.map((r) => r.d);
}

/** All published picks for one weekly issue. */
export async function picksForWeekly(db: DB, weeklyIssueId: string): Promise<ArticleCardPick[]> {
  const rows = await rawPicks(
    db,
    and(eq(picks.status, "published"), eq(picks.weeklyIssueId, weeklyIssueId)),
    [picks.dailyDate, picks.positionInDay],
  );
  return hydrate(db, rows);
}

/** Weekly issue by number (URL slug is the number). */
export async function weeklyByNumber(db: DB, number: number): Promise<typeof weeklyIssues.$inferSelect | null> {
  const result = await db
    .select()
    .from(weeklyIssues)
    .where(and(eq(weeklyIssues.number, number), sql`${weeklyIssues.publishedAt} is not null`))
    .limit(1);
  return result[0] ?? null;
}

/** All published weekly issues newest first. */
export async function allWeeklies(
  db: DB,
): Promise<
  (typeof weeklyIssues.$inferSelect & {
    pick_count: number;
    read_minutes: number;
    section_count: number;
  })[]
> {
  const result = await db
    .select({
      id: weeklyIssues.id,
      number: weeklyIssues.number,
      slug: weeklyIssues.slug,
      titleZh: weeklyIssues.titleZh,
      titleEn: weeklyIssues.titleEn,
      dateStart: weeklyIssues.dateStart,
      dateEnd: weeklyIssues.dateEnd,
      introZh: weeklyIssues.introZh,
      introEn: weeklyIssues.introEn,
      coverImageKey: weeklyIssues.coverImageKey,
      publishedAt: weeklyIssues.publishedAt,
      createdAt: weeklyIssues.createdAt,
      layoutJson: weeklyIssues.layoutJson,
      pick_count: sql<number>`(select count(*) from picks p where p.weekly_issue_id = weekly_issues.id)`,
      read_minutes: sql<number>`(select coalesce(sum(read_minutes), 0) from picks p where p.weekly_issue_id = weekly_issues.id)`,
      section_count: sql<number>`json_array_length(coalesce(weekly_issues.layout_json, '[]'))`,
    })
    .from(weeklyIssues)
    .where(sql`${weeklyIssues.publishedAt} is not null`)
    .orderBy(desc(weeklyIssues.number));
  return result as any;
}

type WeeklyRow = Awaited<ReturnType<typeof allWeeklies>>[number];

function weeklyCoverFromRow(w: WeeklyRow): WeeklyCoverIssue {
  return {
    number: w.number,
    slug: w.slug,
    title_zh: w.titleZh,
    title_en: w.titleEn,
    date_start: w.dateStart,
    date_end: w.dateEnd,
    intro_zh: w.introZh,
    intro_en: w.introEn,
    pick_count: w.pick_count,
    cover_image_url: null,
  };
}

/** Latest published weekly with pick count — for the homepage cover. */
export async function latestWeeklyCover(db: DB): Promise<WeeklyCoverIssue | null> {
  const all = await allWeeklies(db);
  return all.length === 0 ? null : weeklyCoverFromRow(all[0]!);
}

/** Picks tagged with a given slug. */
export async function picksForTag(db: DB, tagSlug: string, limit = 100): Promise<ArticleCardPick[]> {
  const idRows = await db
    .select({ pick_id: pickTags.pickId })
    .from(pickTags)
    .where(eq(pickTags.tagSlug, tagSlug));
  const ids = idRows.map((r) => r.pick_id);
  if (ids.length === 0) return [];
  const rows = await rawPicks(
    db,
    and(eq(picks.status, "published"), inArray(picks.id, ids)),
    [desc(picks.publishedAt)],
    limit,
  );
  return hydrate(db, rows);
}

export interface SearchPicksParams {
  /** Case-insensitive substring match over zh/en title + summary. */
  q?: string;
  /** Tag slug — only picks carrying this tag. */
  tag?: string;
  /** Category slug. */
  category?: string;
  /** Exact daily date (YYYY-MM-DD). */
  date?: string;
  limit?: number;
  offset?: number;
}

/** Page-size defaults for the public picks API — shared so the endpoint's
 *  pagination math agrees with the clamp applied here. */
export const PICKS_DEFAULT_LIMIT = 50;
export const PICKS_MAX_LIMIT = 200;

/** Escape LIKE wildcards so a literal % or _ in the query is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Search/filter published picks for the public read API (powers the CLI's
 * `query` and the index for `ask`). All filters are AND-ed; `q` is OR-ed across
 * the four text columns. Newest-published first.
 */
export async function searchPicks(db: DB, params: SearchPicksParams): Promise<ArticleCardPick[]> {
  const limit = Math.min(Math.max(params.limit ?? PICKS_DEFAULT_LIMIT, 1), PICKS_MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  const conds = [eq(picks.status, "published")];
  if (params.category) conds.push(eq(picks.category, params.category));
  if (params.date) conds.push(eq(picks.dailyDate, params.date));
  const q = params.q?.trim();
  if (q) {
    const needle = `%${escapeLike(q.toLowerCase())}%`;
    const text = or(
      sql`lower(${picks.titleZh}) like ${needle} escape '\\'`,
      sql`lower(${picks.titleEn}) like ${needle} escape '\\'`,
      sql`lower(${picks.summaryZh}) like ${needle} escape '\\'`,
      sql`lower(${picks.summaryEn}) like ${needle} escape '\\'`,
    );
    if (text) conds.push(text);
  }
  if (params.tag) {
    const idRows = await db
      .select({ id: pickTags.pickId })
      .from(pickTags)
      .where(eq(pickTags.tagSlug, params.tag));
    const ids = idRows.map((r) => r.id);
    if (ids.length === 0) return [];
    conds.push(inArray(picks.id, ids));
  }

  const rows = await rawPicks(
    db,
    and(...conds),
    [desc(picks.publishedAt), desc(picks.positionInDay)],
    limit,
    offset,
  );
  return hydrate(db, rows);
}

/** Single pick by slug, with annotations + tags + glossary + next-hints. */
export async function pickBySlug(db: DB, slug: string): Promise<
  | (ArticleCardPick & {
      sections: {
        heading_zh: string;
        heading_en: string;
        body_zh: string;
        body_en: string;
        anchor_id?: string;
      }[];
      source_url: string;
      published_at: Date | null;
      daily_date: string;
      position_in_day: number;
      lang: "zh" | "en" | "other" | null;
      annotations: { id: string; anchor: string; body_zh: string; body_en: string; position: number }[];
      glossary: { en: string; zh: string; meaning: string; anchor?: string }[];
      next_hints: string[];
    })
  | null
> {
  const result = await db
    .select()
    .from(picks)
    .where(and(eq(picks.slug, slug), eq(picks.status, "published")))
    .limit(1);
  const row = result[0];
  if (!row) return null;
  const tagMap = await attachTags(db, [row.id]);
  const ann = await db
    .select()
    .from(articleAnnotations)
    .where(eq(articleAnnotations.pickId, row.id))
    .orderBy(articleAnnotations.position);

  return {
    id: row.id,
    slug: row.slug,
    title_zh: row.titleZh,
    title_en: row.titleEn,
    summary_zh: row.summaryZh,
    summary_en: row.summaryEn,
    bullets: safeJson(row.bulletsJson) as { zh: string; en: string }[],
    editor_note_zh: row.editorNoteZh,
    editor_note_en: row.editorNoteEn,
    source_url: row.sourceUrl,
    source_host: row.sourceHost,
    read_minutes: row.readMinutes,
    category: row.category,
    submitter_name: row.submitterName,
    tags: tagMap.get(row.id) ?? [],
    sections: safeJson(row.sectionsJson) as {
      heading_zh: string;
      heading_en: string;
      body_zh: string;
      body_en: string;
      anchor_id?: string;
    }[],
    annotations: ann.map((a) => ({
      id: a.id,
      anchor: a.anchor,
      body_zh: a.bodyZh,
      body_en: a.bodyEn,
      position: a.position,
    })),
    glossary: safeJson(row.glossaryJson) as {
      en: string; zh: string; meaning: string; anchor?: string;
    }[],
    next_hints: safeJson(row.nextHintsJson) as string[],
    published_at: row.publishedAt,
    daily_date: row.dailyDate,
    position_in_day: row.positionInDay,
    lang: (row.lang ?? null) as "zh" | "en" | "other" | null,
  };
}

export type AdjacentPick = {
  slug: string;
  title_zh: string;
  title_en: string;
  daily_date: string;
};

/**
 * Previous/next published picks on the global timeline, ordered by
 * (daily_date, position_in_day). Dates are 'YYYY-MM-DD' text, so a
 * lexicographic compare is chronological. `prev` is the immediately OLDER pick
 * (largest tuple strictly less than the current one); `next` is the
 * immediately NEWER pick. Either is null at the ends of the archive.
 */
export async function adjacentPicks(
  db: DB,
  current: { dailyDate: string; positionInDay: number },
): Promise<{ prev: AdjacentPick | null; next: AdjacentPick | null }> {
  const cols = {
    slug: picks.slug,
    title_zh: picks.titleZh,
    title_en: picks.titleEn,
    daily_date: picks.dailyDate,
  };
  const { dailyDate: d, positionInDay: p } = current;

  const prevRows = await db
    .select(cols)
    .from(picks)
    .where(
      and(
        eq(picks.status, "published"),
        or(
          lt(picks.dailyDate, d),
          and(eq(picks.dailyDate, d), lt(picks.positionInDay, p)),
        ),
      ),
    )
    .orderBy(desc(picks.dailyDate), desc(picks.positionInDay))
    .limit(1);

  const nextRows = await db
    .select(cols)
    .from(picks)
    .where(
      and(
        eq(picks.status, "published"),
        or(
          gt(picks.dailyDate, d),
          and(eq(picks.dailyDate, d), gt(picks.positionInDay, p)),
        ),
      ),
    )
    .orderBy(asc(picks.dailyDate), asc(picks.positionInDay))
    .limit(1);

  return { prev: prevRows[0] ?? null, next: nextRows[0] ?? null };
}

/** All distinct tags with current pick counts (for the tag-edge page sidebar). */
export async function allTagsWithCounts(db: DB): Promise<{ slug: string; name_zh: string; name_en: string; family: string; count: number }[]> {
  const result = await db
    .select({
      slug: tagsTable.slug,
      name_zh: tagsTable.nameZh,
      name_en: tagsTable.nameEn,
      family: tagsTable.family,
      count: sql<number>`(select count(*) from pick_tags pt where pt.tag_slug = tags.slug)`,
    })
    .from(tagsTable)
    .orderBy(tagsTable.slug);
  return result as any;
}

/** All categories (for tag-index grouping labels + admin category input). */
export async function allCategories(db: DB): Promise<CategoryRow[]> {
  return db.select().from(categoriesTable).orderBy(categoriesTable.slug);
}

export interface WikiStatusEvent {
  stage: string;
  status: string;
  message: string | null;
  created_at: Date | null;
}

/** Latest wiki-build lifecycle event (queued | started | ok | failed) so
 *  /admin/wiki can show live state + the failure reason. Keyed by the stable
 *  "wiki" submission id that the rebuild endpoint + runWikiBuild both log under. */
export async function latestWikiEvent(db: DB): Promise<WikiStatusEvent | null> {
  const rows = await db
    .select({
      stage: submissionEvents.stage,
      status: submissionEvents.status,
      message: submissionEvents.message,
      created_at: submissionEvents.createdAt,
    })
    .from(submissionEvents)
    .where(eq(submissionEvents.submissionId, "wiki"))
    .orderBy(desc(submissionEvents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The live wiki index = the most recently generated row (rebuild publishes live). */
export async function currentWikiIndex(db: DB): Promise<WikiIndexView | null> {
  const rows = await db
    .select()
    .from(wikiIndex)
    .orderBy(desc(wikiIndex.generatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    intro_zh: row.introZh,
    intro_en: row.introEn,
    topics: safeJson(row.topicsJson) as WikiTopic[],
    picks_count: row.picksCount,
    model: row.model,
    generated_at: row.generatedAt,
  };
}

/** A lightweight catalog row for the wiki build (full + incremental). */
export interface WikiCatalogPick {
  slug: string;
  title_zh: string;
  title_en: string;
  summary_en: string;
  category: string;
  tags: { slug: string }[];
}

/** Newest-first published picks shaped for the wiki build. Deliberately NOT
 *  clamped to PICKS_MAX_LIMIT — the incremental sweep must see the whole
 *  corpus to find picks the wiki doesn't cover yet. */
export async function picksForWiki(db: DB, limit: number): Promise<WikiCatalogPick[]> {
  const rows = await db
    .select({
      id: picks.id,
      slug: picks.slug,
      title_zh: picks.titleZh,
      title_en: picks.titleEn,
      summary_en: picks.summaryEn,
      category: picks.category,
    })
    .from(picks)
    .where(eq(picks.status, "published"))
    .orderBy(desc(picks.publishedAt), desc(picks.positionInDay))
    .limit(limit);
  const tagMap = await attachTags(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    slug: r.slug,
    title_zh: r.title_zh,
    title_en: r.title_en,
    summary_en: r.summary_en,
    category: r.category,
    tags: (tagMap.get(r.id) ?? []).map((t) => ({ slug: t.slug })),
  }));
}

/** Total published picks — coverage denominator + MAX_PICKS warning on /admin/wiki. */
export async function publishedPickCount(db: DB): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)` })
    .from(picks)
    .where(eq(picks.status, "published"));
  return r[0]?.n ?? 0;
}

/** Recent wiki index versions for the admin history list (newest first). */
export interface WikiVersionSummary {
  id: string;
  generated_at: Date;
  topics_count: number;
  picks_count: number;
  model: string | null;
}

export async function recentWikiIndexes(db: DB, limit = 10): Promise<WikiVersionSummary[]> {
  const rows = await db
    .select()
    .from(wikiIndex)
    .orderBy(desc(wikiIndex.generatedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    generated_at: row.generatedAt,
    topics_count: (safeJson(row.topicsJson) as WikiTopic[]).length,
    picks_count: row.picksCount,
    model: row.model,
  }));
}

/** Admin: all issues incl. drafts, newest first. */
export async function allWeekliesAdmin(db: DB): Promise<(typeof weeklyIssues.$inferSelect)[]> {
  return db.select().from(weeklyIssues).orderBy(desc(weeklyIssues.number));
}

/** Admin: single issue by id (draft or published). */
export async function weeklyById(db: DB, id: string): Promise<typeof weeklyIssues.$inferSelect | null> {
  const r = await db.select().from(weeklyIssues).where(eq(weeklyIssues.id, id)).limit(1);
  return r[0] ?? null;
}

/** Max issue number across all issues (for number = max+1). 0 if none. */
export async function maxWeeklyNumber(db: DB): Promise<number> {
  const r = await db.select({ m: sql<number>`coalesce(max(number), 0)` }).from(weeklyIssues);
  return r[0]?.m ?? 0;
}

/** Today's lead + 2 supporting for the homepage strip. */
export async function homeFeed(db: DB, today: string): Promise<{
  date: string;
  picks: ArticleCardPick[];
  weekly: WeeklyCoverIssue | null;
  weeklyToc: WeeklyTocGroup[];
}> {
  let date = today;
  let picksList = await dailyPicksForDate(db, date);
  if (picksList.length === 0) {
    const dates = await recentDailyDates(db, 1);
    if (dates.length > 0) {
      date = dates[0]!;
      picksList = await dailyPicksForDate(db, date);
    }
  }

  // Latest issue cover + its table of contents (section → article titles) for
  // the homepage. One allWeeklies call feeds both; the TOC needs the issue's
  // picks + layout, so it's a second query only when an issue exists.
  const all = await allWeeklies(db);
  const latest = all[0] ?? null;
  const weekly = latest ? weeklyCoverFromRow(latest) : null;
  let weeklyToc: WeeklyTocGroup[] = [];
  if (latest) {
    const issuePicks = await picksForWeekly(db, latest.id);
    const layout: LayoutSection[] = latest.layoutJson ? JSON.parse(latest.layoutJson) : [];
    weeklyToc = buildWeeklyGroups(layout, issuePicks).map((g) => ({
      zh: g.zh,
      en: g.en,
      items: g.picks.map((p) => ({ title_zh: p.title_zh, title_en: p.title_en, slug: p.slug })),
    }));
  }

  return { date, picks: picksList.slice(0, 3), weekly, weeklyToc };
}

// --- Newsletter delivery --------------------------------------------------

export interface Recipient {
  email: string;
  langPref: "zh" | "en";
}

/** Confirmed, non-unsubscribed subscribers — the weekly blast audience. */
export async function confirmedSubscribers(db: DB): Promise<Recipient[]> {
  return db
    .select({ email: subscribers.email, langPref: subscribers.langPref })
    .from(subscribers)
    .where(and(isNotNull(subscribers.confirmedAt), isNull(subscribers.unsubscribedAt)));
}

/** Count of the weekly blast audience (for the admin editor). */
export async function confirmedSubscriberCount(db: DB): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)` })
    .from(subscribers)
    .where(and(isNotNull(subscribers.confirmedAt), isNull(subscribers.unsubscribedAt)));
  return r[0]?.n ?? 0;
}

/** Emails already successfully sent this issue — used to make re-sending idempotent. */
export async function sentEmailsForIssue(db: DB, issueId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: weeklyDeliveries.email })
    .from(weeklyDeliveries)
    .where(and(eq(weeklyDeliveries.issueId, issueId), eq(weeklyDeliveries.status, "sent")));
  return new Set(rows.map((r) => r.email));
}
