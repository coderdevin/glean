/**
 * Shared publish core for ready submissions.
 *
 * `publishSubmission` is the single source of truth for turning a 'ready'
 * submission into a live pick — used by BOTH the admin publish route (fields
 * from the editor's form) and the daily auto-publish cron (fields from the
 * submission's stored AI output). Keeping one core means the two paths can't
 * drift on slug shape, position assignment, read-time, tag linking, or the
 * submission write-back.
 */
import { and, desc, eq, isNull, notLike, sql } from "drizzle-orm";
import { ulid } from "./ulid";
import { db } from "~/db/client";
import { pickTags, picks, submissions, tags, categories, albums, type Submission } from "~/db/schema";
import { slugify } from "./adminForm";
import { sanitizeCategory } from "./category";
import { bustForPick } from "./cache";
import { siteTz, todayInSiteTz } from "./datetime";
import { logEvent } from "./ingest";

/** Minimal env surface publishSubmission needs. RAW/CACHE are optional: a
 *  worker without them just skips read-time measurement / cache busting. */
export interface PublishEnv {
  DB: D1Database;
  RAW?: R2Bucket;
  CACHE?: KVNamespace;
  SITE_TZ?: string;
}

/** Resolved editorial fields, however they were sourced (form or AI). */
export interface PublishFields {
  titleZh: string;
  titleEn: string;
  summaryZh: string;
  summaryEn: string;
  bullets: { zh: string; en: string }[];
  tagSlugs: string[];
  category: (typeof picks.$inferInsert)["category"];
  score: number;
  editorZh: string | null;
  editorEn: string | null;
  submitter: string | null;
}

/**
 * Publish (or re-publish) a single submission as a live pick. Inserts/updates
 * the pick, reconciles tags, flips the submission to 'published' with a linked
 * pick id, and busts the public cache. Caller guarantees the submission is in a
 * publishable state ('ready', or already-published re-save).
 */
export async function publishSubmission(
  env: PublishEnv,
  sub: Submission,
  fields: PublishFields,
  opts?: { albumId?: string },
): Promise<{ pickId: string; slug: string }> {
  const drizzleDb = db(env.DB);
  const pickId = sub.linkedPickId ?? ulid();

  // Album membership: append after the album's current last member. Only
  // computed for a NEW pick — a re-publish keeps its existing position (the
  // update branch below omits position_in_album). Album picks stay out of the
  // daily/home/RSS streams via the `album_id IS NULL` query filter.
  const albumId = opts?.albumId ?? null;
  let positionInAlbum = 0;
  if (albumId) {
    const q = await drizzleDb
      .select({ max: sql<number>`coalesce(max(position_in_album), -1)` })
      .from(picks)
      .where(eq(picks.albumId, albumId));
    positionInAlbum = (q[0]?.max ?? -1) + 1;
  }
  // Editorial "today" follows SITE_TZ — at 06:00 Beijing the cron must land
  // picks on the new local day, not yesterday in UTC.
  const today = todayInSiteTz(siteTz(env));
  const sourceHost = (() => {
    try { return new URL(sub.url).host; } catch { return sub.url; }
  })();
  const slugSeed = fields.titleEn || fields.titleZh || sub.url;
  const slug = `${slugify(slugSeed)}-${pickId.slice(-6).toLowerCase()}`;

  // Non-album picks take the next daily-stream slot. Album picks get no daily
  // placement (position 0, and album_id keeps them out of the stream) so they
  // never consume or reshuffle the day's positions. See docs/adr/0002.
  let position = 0;
  if (!albumId) {
    const posQuery = await drizzleDb
      .select({ max: sql<number>`coalesce(max(position_in_day), -1)` })
      .from(picks)
      .where(and(eq(picks.dailyDate, today), isNull(picks.albumId)));
    position = (posQuery[0]?.max ?? -1) + 1;
  }

  // Reading time — measure the actual extracted body in R2 (~1000 chars/min
  // covers a ZH/EN mix). Min 1.
  let readMinutes = 1;
  if (sub.rawR2Key && env.RAW) {
    try {
      const obj = await env.RAW.get(sub.rawR2Key);
      if (obj) {
        const text = await obj.text();
        readMinutes = Math.max(1, Math.round(text.length / 1000));
      }
    } catch (err) {
      console.warn("publish: R2 fetch failed for read_minutes", err);
    }
  }

  const now = new Date();
  const bulletsJson = JSON.stringify(fields.bullets);
  await drizzleDb
    .insert(picks)
    .values({
      id: pickId,
      slug,
      titleZh: fields.titleZh,
      titleEn: fields.titleEn,
      summaryZh: fields.summaryZh,
      summaryEn: fields.summaryEn,
      bulletsJson,
      editorNoteZh: fields.editorZh,
      editorNoteEn: fields.editorEn,
      sourceUrl: sub.url,
      sourceHost,
      readMinutes,
      category: fields.category,
      dailyDate: today,
      weeklyIssueId: null,
      positionInDay: position,
      albumId,
      positionInAlbum,
      score: fields.score,
      submitterName: fields.submitter,
      status: "published",
      publishedAt: now,
      createdAt: now,
      glossaryJson: sub.aiGlossaryJson,
      nextHintsJson: sub.aiNextHintsJson,
      sectionsJson: sub.aiSectionsJson,
      lang: sub.extractedLang,
    })
    .onConflictDoUpdate({
      target: picks.id,
      set: {
        slug,
        titleZh: fields.titleZh,
        titleEn: fields.titleEn,
        summaryZh: fields.summaryZh,
        summaryEn: fields.summaryEn,
        bulletsJson,
        editorNoteZh: fields.editorZh,
        editorNoteEn: fields.editorEn,
        category: fields.category,
        score: fields.score,
        glossaryJson: sub.aiGlossaryJson,
        nextHintsJson: sub.aiNextHintsJson,
        sectionsJson: sub.aiSectionsJson,
        lang: sub.extractedLang,
        albumId,
        status: "published",
        publishedAt: now,
      },
    });

  // Ensure the (possibly hand-typed) category exists as a category row so tag
  // grouping + badge naming work. Existing rows keep their names/colors.
  {
    const c = sanitizeCategory(fields.category, "code");
    await drizzleDb
      .insert(categories)
      .values({ slug: c.slug, nameZh: c.nameZh, nameEn: c.nameEn, color: null })
      .onConflictDoNothing();
  }

  await drizzleDb.delete(pickTags).where(eq(pickTags.pickId, pickId));
  if (fields.tagSlugs.length > 0) {
    const existing = await drizzleDb.select().from(tags);
    const existingSet = new Set(existing.map((t) => t.slug));
    const toCreate = fields.tagSlugs.filter((t) => !existingSet.has(t));
    for (const s of toCreate) {
      await drizzleDb
        .insert(tags)
        .values({
          slug: s,
          nameZh: s,
          nameEn: s.replace(/(^|\s|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase()),
          family: fields.category,
        })
        .onConflictDoNothing();
    }
    for (const t of fields.tagSlugs) {
      await drizzleDb.insert(pickTags).values({ pickId, tagSlug: t }).onConflictDoNothing();
    }
  }

  await drizzleDb
    .update(submissions)
    .set({
      status: "published",
      linkedPickId: pickId,
      reviewedAt: now,
      aiTitleZh: fields.titleZh,
      aiTitleEn: fields.titleEn,
      aiSummaryZh: fields.summaryZh,
      aiSummaryEn: fields.summaryEn,
      aiBulletsJson: bulletsJson,
      aiTagsJson: JSON.stringify(fields.tagSlugs),
      aiCategory: fields.category,
      aiScore: fields.score,
      editorNoteZh: fields.editorZh,
      editorNoteEn: fields.editorEn,
      submitterName: fields.submitter,
    })
    .where(eq(submissions.id, sub.id));

  if (env.CACHE) {
    await bustForPick(env.CACHE, { slug, dailyDate: today, weeklyIssueId: null }, fields.tagSlugs);
  }

  return { pickId, slug };
}

/** Coerce a stored JSON array of {zh,en} bullets; tolerant of null/garbage. */
function parseBulletsJson(raw: string | null | undefined): { zh: string; en: string }[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .map((b) => ({ zh: String(b?.zh ?? "").trim(), en: String(b?.en ?? "").trim() }))
      .filter((b) => b.zh || b.en);
  } catch {
    return [];
  }
}

/** Coerce a stored JSON array of tag slugs; tolerant of null/garbage. */
function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Parse the album slug out of an album-import submission's source tag
 *  ("album:<slug>"), or null for any other origin. */
export function albumSlugFromSource(source: string | null | undefined): string | null {
  const s = source ?? "";
  return s.startsWith("album:") ? s.slice("album:".length) || null : null;
}

/**
 * Auto-publish a single album-import submission into its album from stored AI
 * output — the album analog of the daily auto-publish, called by the
 * llm-consumer as soon as an `album:<slug>` submission reaches 'ready'. The
 * pick lands in the album (album_id set, out of the daily stream); the album's
 * own draft/published status gates public visibility. Non-throwing: returns
 * "published" | "skipped" | "not-album" and logs the outcome.
 */
export async function autoPublishAlbumSubmission(
  env: PublishEnv,
  sub: Submission,
): Promise<"published" | "skipped" | "not-album"> {
  const slug = albumSlugFromSource(sub.source);
  if (!slug) return "not-album";
  const drizzleDb = db(env.DB);
  const albumRow = (await drizzleDb.select().from(albums).where(eq(albums.slug, slug)).limit(1))[0];
  if (!albumRow) {
    await logEvent(env, sub.id, "pipeline", "skipped", {
      message: `album auto-publish skipped: album '${slug}' not found`,
      meta: { source: "album-publish", slug },
    });
    return "skipped";
  }
  const fields = publishFieldsFromAi(sub);
  if (!fields) {
    await logEvent(env, sub.id, "pipeline", "skipped", {
      message: "album auto-publish skipped: missing AI title/summary",
      meta: { source: "album-publish", slug },
    });
    return "skipped";
  }
  try {
    const { pickId } = await publishSubmission(env, sub, fields, { albumId: albumRow.id });
    await logEvent(env, sub.id, "pipeline", "ok", {
      message: `auto-published into album '${slug}'`,
      meta: { source: "album-publish", slug, pickId },
    });
    return "published";
  } catch (err) {
    await logEvent(env, sub.id, "pipeline", "failed", {
      message: `album auto-publish failed: ${(err as Error).message}`,
      meta: { source: "album-publish", slug },
    });
    return "skipped";
  }
}

/**
 * Build publish fields from a submission's stored AI output (no human review).
 * Returns null when the core bilingual copy is missing — such a row isn't
 * safely publishable unattended, so the cron skips it.
 */
export function publishFieldsFromAi(sub: Submission): PublishFields | null {
  const titleZh = sub.aiTitleZh?.trim();
  const titleEn = sub.aiTitleEn?.trim();
  const summaryZh = sub.aiSummaryZh?.trim();
  const summaryEn = sub.aiSummaryEn?.trim();
  if (!titleZh || !titleEn || !summaryZh || !summaryEn) return null;
  return {
    titleZh,
    titleEn,
    summaryZh,
    summaryEn,
    bullets: parseBulletsJson(sub.aiBulletsJson),
    tagSlugs: parseTagsJson(sub.aiTagsJson),
    category: sub.aiCategory ?? "code",
    score: typeof sub.aiScore === "number" && Number.isFinite(sub.aiScore) ? sub.aiScore : 0.5,
    editorZh: sub.editorNoteZh ?? null,
    editorEn: sub.editorNoteEn ?? null,
    submitter: sub.submitterName ?? null,
  };
}

/**
 * Auto-publish the newest `limit` 'ready' submissions (LIFO — most recently
 * added first, by createdAt desc) from their AI output, no human review. Used by
 * the daily cron. Non-throwing per item — one bad row never blocks the rest.
 * Returns ids published + skipped.
 */
export async function autoPublishReady(
  env: PublishEnv,
  limit = 3,
): Promise<{ published: string[]; skipped: number }> {
  const drizzleDb = db(env.DB);
  // Exclude album-import rows (source "album:<slug>"): they auto-publish into
  // their album, never the daily stream. Without this, an album row stranded in
  // 'ready' (album missing / publish errored) would leak into the daily feed
  // with no album_id. See docs/adr/0002.
  const ready = await drizzleDb
    .select()
    .from(submissions)
    .where(and(eq(submissions.status, "ready"), notLike(submissions.source, "album:%")))
    .orderBy(desc(submissions.createdAt))
    .limit(limit);

  const published: string[] = [];
  let skipped = 0;
  for (const sub of ready) {
    const fields = publishFieldsFromAi(sub);
    if (!fields) {
      skipped++;
      await logEvent(env, sub.id, "pipeline", "skipped", {
        message: "auto-publish skipped: missing AI title/summary",
        meta: { source: "auto-publish" },
      });
      continue;
    }
    try {
      const { pickId } = await publishSubmission(env, sub, fields);
      published.push(sub.id);
      await logEvent(env, sub.id, "pipeline", "ok", {
        message: "auto-published by daily cron",
        meta: { source: "auto-publish", pickId },
      });
    } catch (err) {
      skipped++;
      await logEvent(env, sub.id, "pipeline", "failed", {
        message: `auto-publish failed: ${(err as Error).message}`,
        meta: { source: "auto-publish" },
      });
    }
  }
  return { published, skipped };
}
