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
  weeklyIssues,
  weeklyDeliveries,
  subscribers,
  articleAnnotations,
} from "~/db/schema";
import type { ArticleCardPick } from "~/components/ArticleCard.astro";
import type { WeeklyCoverIssue } from "~/components/WeeklyCover.astro";

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
  category: "infra" | "data" | "code";
  daily_date: string;
  weekly_issue_id: string | null;
  position_in_day: number;
  submitter_name: string | null;
  published_at: Date | null;
}

function rowsToCardPicks(
  rows: PickRow[],
  tagMap: Map<string, { slug: string; name_zh: string; name_en: string; family: "infra" | "data" | "code" }[]>,
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

async function attachTags(
  db: DB,
  pickIds: string[],
): Promise<Map<string, { slug: string; name_zh: string; name_en: string; family: "infra" | "data" | "code" }[]>> {
  if (pickIds.length === 0) return new Map();
  const rows = await db
    .select({
      pick_id: pickTags.pickId,
      slug: tagsTable.slug,
      name_zh: tagsTable.nameZh,
      name_en: tagsTable.nameEn,
      family: tagsTable.family,
    })
    .from(pickTags)
    .innerJoin(tagsTable, eq(pickTags.tagSlug, tagsTable.slug))
    .where(inArray(pickTags.pickId, pickIds));

  const map = new Map<string, { slug: string; name_zh: string; name_en: string; family: "infra" | "data" | "code" }[]>();
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

/** Latest published weekly with pick count — for the homepage cover. */
export async function latestWeeklyCover(db: DB): Promise<WeeklyCoverIssue | null> {
  const all = await allWeeklies(db);
  if (all.length === 0) return null;
  const w = all[0]!;
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
export async function allTagsWithCounts(db: DB): Promise<{ slug: string; name_zh: string; name_en: string; family: "infra" | "data" | "code"; count: number }[]> {
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
  const weekly = await latestWeeklyCover(db);
  return { date, picks: picksList.slice(0, 3), weekly };
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
