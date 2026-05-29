import type { APIRoute } from "astro";
import { asc, eq, sql } from "drizzle-orm";
import { ulid } from "~/lib/ulid";
import { db } from "~/db/client";
import { pickTags, picks, submissions, tags } from "~/db/schema";
import {
  parseBulletLines,
  parseTags,
  readAdminForm,
  slugify,
} from "~/lib/adminForm";
import { bustForPick } from "~/lib/cache";
import { siteTz, todayInSiteTz } from "~/lib/datetime";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const form = await readAdminForm(ctx.request);
  const bullets = parseBulletLines(form.bullets_zh, form.bullets_en);
  const tagSlugs = parseTags(form.tags);

  const sRows = await db(env.DB).select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const sub = sRows[0];
  if (!sub) return new Response("not found", { status: 404 });
  if (sub.status === "published" && sub.linkedPickId) {
    return new Response(null, { status: 303, headers: { Location: `/admin/${id}` } });
  }
  // Single source of truth: only a 'ready' row is publishable. Reaching
  // 'ready' already guarantees the sections phase succeeded (status machine).
  if (sub.status !== "ready") {
    return new Response(
      `cannot publish: status is '${sub.status}', expected 'ready'`,
      { status: 409 },
    );
  }

  const drizzleDb = db(env.DB);
  const pickId = sub.linkedPickId ?? ulid();
  // Editorial "today" follows SITE_TZ — at 00:30 Beijing time the editor
  // expects the new local day, not yesterday in UTC.
  const today = todayInSiteTz(siteTz(env));
  const sourceHost = (() => { try { return new URL(sub.url).host; } catch { return sub.url; } })();
  const slugSeed = form.title_en || form.title_zh || sub.url;
  const slug = `${slugify(slugSeed)}-${pickId.slice(-6).toLowerCase()}`;

  const posQuery = await drizzleDb
    .select({ max: sql<number>`coalesce(max(position_in_day), -1)` })
    .from(picks)
    .where(eq(picks.dailyDate, today));
  const position = (posQuery[0]?.max ?? -1) + 1;

  // Reading time — measure the actual extracted body in R2.
  // Rough rate: ~1000 chars/min covers a mix of ZH (~400 字/min) and EN
  // (~250 wpm × 5 chars/word ≈ 1250 chars/min). Min 1.
  let readMinutes = 1;
  if (sub.rawR2Key) {
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
  // Carry glossary + next-hints from the submission's AI output through
  // to the published pick (editor doesn't edit these directly in this UI).
  await drizzleDb.insert(picks).values({
    id: pickId,
    slug,
    titleZh: form.title_zh,
    titleEn: form.title_en,
    summaryZh: form.summary_zh,
    summaryEn: form.summary_en,
    bulletsJson: JSON.stringify(bullets),
    editorNoteZh: form.editor_zh || null,
    editorNoteEn: form.editor_en || null,
    sourceUrl: sub.url,
    sourceHost,
    readMinutes,
    category: form.category,
    dailyDate: today,
    weeklyIssueId: null,
    positionInDay: position,
    score: form.score,
    submitterName: form.submitter.trim() || null,
    status: "published",
    publishedAt: now,
    createdAt: now,
    glossaryJson: sub.aiGlossaryJson,
    nextHintsJson: sub.aiNextHintsJson,
    sectionsJson: sub.aiSectionsJson,
    lang: sub.extractedLang,
  }).onConflictDoUpdate({
    target: picks.id,
    set: {
      slug,
      titleZh: form.title_zh,
      titleEn: form.title_en,
      summaryZh: form.summary_zh,
      summaryEn: form.summary_en,
      bulletsJson: JSON.stringify(bullets),
      editorNoteZh: form.editor_zh || null,
      editorNoteEn: form.editor_en || null,
      category: form.category,
      score: form.score,
      glossaryJson: sub.aiGlossaryJson,
      nextHintsJson: sub.aiNextHintsJson,
      sectionsJson: sub.aiSectionsJson,
      lang: sub.extractedLang,
      status: "published",
      publishedAt: now,
    },
  });

  await drizzleDb.delete(pickTags).where(eq(pickTags.pickId, pickId));
  if (tagSlugs.length > 0) {
    const existing = await drizzleDb.select().from(tags);
    const existingSet = new Set(existing.map((t) => t.slug));
    const toCreate = tagSlugs.filter((t) => !existingSet.has(t));
    for (const slug of toCreate) {
      await drizzleDb.insert(tags).values({
        slug,
        nameZh: slug,
        nameEn: slug.replace(/(^|\s|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase()),
        family: form.category,
      }).onConflictDoNothing();
    }
    for (const t of tagSlugs) {
      await drizzleDb.insert(pickTags).values({ pickId, tagSlug: t }).onConflictDoNothing();
    }
  }

  await drizzleDb.update(submissions).set({
    status: "published",
    linkedPickId: pickId,
    reviewedAt: now,
    aiTitleZh: form.title_zh,
    aiTitleEn: form.title_en,
    aiSummaryZh: form.summary_zh,
    aiSummaryEn: form.summary_en,
    aiBulletsJson: JSON.stringify(bullets),
    aiTagsJson: JSON.stringify(tagSlugs),
    aiCategory: form.category,
    aiScore: form.score,
    editorNoteZh: form.editor_zh || null,
    editorNoteEn: form.editor_en || null,
    submitterName: form.submitter.trim() || null,
  }).where(eq(submissions.id, id));

  await bustForPick(env.CACHE, { slug, dailyDate: today, weeklyIssueId: null }, tagSlugs);

  const next = await drizzleDb
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.status, "ready"))
    .orderBy(asc(submissions.createdAt))
    .limit(1);
  const nextLoc = next[0]?.id ? `/admin/${next[0].id}` : "/admin";

  return new Response(null, { status: 303, headers: { Location: nextLoc } });
};
