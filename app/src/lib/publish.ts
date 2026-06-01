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
import { asc, eq, sql } from "drizzle-orm";
import { ulid } from "./ulid";
import { db } from "~/db/client";
import { pickTags, picks, submissions, tags, categories, type Submission } from "~/db/schema";
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
): Promise<{ pickId: string; slug: string }> {
  const drizzleDb = db(env.DB);
  const pickId = sub.linkedPickId ?? ulid();
  // Editorial "today" follows SITE_TZ — at 06:00 Beijing the cron must land
  // picks on the new local day, not yesterday in UTC.
  const today = todayInSiteTz(siteTz(env));
  const sourceHost = (() => {
    try { return new URL(sub.url).host; } catch { return sub.url; }
  })();
  const slugSeed = fields.titleEn || fields.titleZh || sub.url;
  const slug = `${slugify(slugSeed)}-${pickId.slice(-6).toLowerCase()}`;

  const posQuery = await drizzleDb
    .select({ max: sql<number>`coalesce(max(position_in_day), -1)` })
    .from(picks)
    .where(eq(picks.dailyDate, today));
  const position = (posQuery[0]?.max ?? -1) + 1;

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
 * Auto-publish the oldest `limit` 'ready' submissions (FIFO by createdAt) from
 * their AI output, no human review. Used by the daily cron. Non-throwing per
 * item — one bad row never blocks the rest. Returns ids published + skipped.
 */
export async function autoPublishReady(
  env: PublishEnv,
  limit = 3,
): Promise<{ published: string[]; skipped: number }> {
  const drizzleDb = db(env.DB);
  const ready = await drizzleDb
    .select()
    .from(submissions)
    .where(eq(submissions.status, "ready"))
    .orderBy(asc(submissions.createdAt))
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
