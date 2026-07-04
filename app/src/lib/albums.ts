/**
 * Albums (专辑) — pure helpers. No I/O; unit-tested via
 * scripts/album-import-plan.test.ts and scripts/album-visibility.test.ts.
 * Network + DB orchestration lives in the import route / worker, over this core.
 */

export interface AlbumCandidate {
  /** Raw URL as found in the feed (normalized later, at plan time). */
  url: string;
  title: string;
}

/**
 * Disposition of an already-known normalized URL, so the import planner can
 * decide enqueue vs adopt vs skip. Built by the caller from D1 lookups.
 */
export type KnownUrl =
  | { kind: "in-flight" } //                  submission exists, not yet a pick → skip
  | { kind: "pick-unowned"; pickId: string } // published pick, no album → adopt
  | { kind: "pick-in-album" }; //             pick already in an album → skip

export interface AlbumImportPlan {
  /** Fresh URLs to insert as submissions + enqueue to glean-ingest. */
  toEnqueue: AlbumCandidate[];
  /** Existing album-less picks to fold into this album (set album_id). */
  toAdopt: { url: string; pickId: string }[];
  /** URLs deliberately not imported, each with an editor-facing reason. */
  skipped: { url: string; reason: string }[];
}

/**
 * Partition feed candidates into enqueue / adopt / skip for one album import.
 * Pure: `known` maps a normalized URL to its disposition; `norm` is injected so
 * tests don't need the real normalizeUrl. Input order is preserved (it drives
 * the default position_in_album, assigned by the caller on append). Dedups
 * within the batch. A URL that fails to normalize is skipped, never fatal.
 */
export function planAlbumImport(
  candidates: AlbumCandidate[],
  known: Map<string, KnownUrl>,
  norm: (u: string) => string,
): AlbumImportPlan {
  const plan: AlbumImportPlan = { toEnqueue: [], toAdopt: [], skipped: [] };
  const seen = new Set<string>();
  for (const cand of candidates) {
    let key: string;
    try {
      key = norm(cand.url);
    } catch {
      plan.skipped.push({ url: cand.url, reason: "无法解析 URL" });
      continue;
    }
    if (!key || seen.has(key)) {
      plan.skipped.push({ url: cand.url, reason: "批内重复" });
      continue;
    }
    seen.add(key);
    const disp = known.get(key);
    if (!disp) {
      plan.toEnqueue.push(cand);
    } else if (disp.kind === "pick-unowned") {
      plan.toAdopt.push({ url: cand.url, pickId: disp.pickId });
    } else if (disp.kind === "pick-in-album") {
      plan.skipped.push({ url: cand.url, reason: "已属于其它专辑" });
    } else {
      plan.skipped.push({ url: cand.url, reason: "已在处理队列中" });
    }
  }
  return plan;
}

export interface PickVisibilityInput {
  /** Which album this pick belongs to, or null for a normal (stream) pick. */
  albumId: string | null;
  /** The album's status, when albumId is set. */
  albumStatus?: "draft" | "published" | null;
}

/**
 * Whether a Pick is publicly reachable at /a/<slug>. A normal (non-album) pick
 * is visible — callers already restrict to published picks. An album pick is
 * gated behind its album's publication: draft (or unknown) album → hidden.
 * Fail-closed so a half-imported album never leaks its members.
 */
export function isPickPubliclyVisible(p: PickVisibilityInput): boolean {
  if (!p.albumId) return true;
  return p.albumStatus === "published";
}

// --- Import orchestration (impure) ----------------------------------------

import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { submissions, picks } from "~/db/schema";
import { parseFeed } from "~/lib/discovery";
import { normalizeUrl } from "~/lib/normalize-url";
import { ulid } from "~/lib/ulid";
import { logEvent } from "~/lib/ingest";
import { bustAlbum } from "~/lib/cache";

export interface AlbumImportEnv {
  DB: D1Database;
  /** Producer binding to the glean-ingest queue (same queue /api/submit uses). */
  INGEST: Queue<string>;
  CACHE?: KVNamespace;
}

export interface AlbumImportResult {
  fetched: number;
  enqueued: number;
  adopted: number;
  skipped: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Bulk-import an album's feed: fetch feed_url, parse to candidates, partition
 * (enqueue / adopt / skip) via planAlbumImport, then enqueue fresh URLs as
 * `album:<slug>` submissions and adopt album-less existing picks. Ungated —
 * every fresh item runs the full extract→LLM pipeline (see docs/adr/0003).
 * Adopted picks append in feed order; enqueued picks append as they finish
 * processing (editor can reorder later).
 */
export async function runAlbumImport(
  env: AlbumImportEnv,
  album: { id: string; slug: string; feedUrl: string | null },
): Promise<AlbumImportResult> {
  if (!album.feedUrl) throw new Error("album has no feed_url");
  const db = drizzle(env.DB);

  const res = await fetch(album.feedUrl);
  if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
  const xml = await res.text();
  const parsed = parseFeed(xml, `album:${album.slug}`);
  const candidates: AlbumCandidate[] = parsed.map((c) => ({ url: c.url, title: c.title }));
  if (candidates.length === 0) return { fetched: 0, enqueued: 0, adopted: 0, skipped: 0 };

  // Build `known`: normalized URL → disposition. A pick (published/adopted)
  // wins over an in-flight submission. Query only the URLs in this batch.
  const keys = candidates
    .map((c) => { try { return normalizeUrl(c.url); } catch { return ""; } })
    .filter(Boolean);
  const known = new Map<string, KnownUrl>();
  for (const part of chunk(keys, 90)) {
    const subRows = await db
      .select({ url: submissions.url })
      .from(submissions)
      .where(inArray(submissions.url, part));
    for (const r of subRows) known.set(r.url, { kind: "in-flight" });
    const pickRows = await db
      .select({ id: picks.id, url: picks.sourceUrl, albumId: picks.albumId })
      .from(picks)
      .where(inArray(picks.sourceUrl, part));
    for (const r of pickRows) {
      known.set(r.url, r.albumId ? { kind: "pick-in-album" } : { kind: "pick-unowned", pickId: r.id });
    }
  }

  const plan = planAlbumImport(candidates, known, normalizeUrl);

  // Adopt existing album-less picks — append after the album's current last.
  let albumMax = -1;
  if (plan.toAdopt.length > 0) {
    const m = await db
      .select({ max: sql<number>`coalesce(max(position_in_album), -1)` })
      .from(picks)
      .where(eq(picks.albumId, album.id));
    albumMax = m[0]?.max ?? -1;
  }
  let adopted = 0;
  for (const a of plan.toAdopt) {
    try {
      await db
        .update(picks)
        .set({ albumId: album.id, positionInAlbum: ++albumMax })
        .where(and(eq(picks.id, a.pickId), isNull(picks.albumId)));
      adopted++;
    } catch (err) {
      console.error("album adopt failed", a.pickId, (err as Error).message);
    }
  }

  // Enqueue fresh candidates as album submissions.
  let enqueued = 0;
  for (const cand of plan.toEnqueue) {
    try {
      const id = ulid();
      const normalized = normalizeUrl(cand.url);
      await db.insert(submissions).values({
        id,
        url: normalized,
        note: null,
        submitterName: null,
        submitterIpHash: null,
        source: `album:${album.slug}`,
        status: "pending",
        processingStartedAt: new Date(),
        processingModel: "extract",
        createdAt: new Date(),
      });
      await env.INGEST.send(id);
      await logEvent(env as never, id, "queue", "queued", {
        message: "album import submission",
        meta: { target: "glean-ingest", source: `album:${album.slug}` },
      });
      enqueued++;
    } catch (err) {
      console.error("album enqueue failed", cand.url, (err as Error).message);
    }
  }

  if ((adopted > 0 || enqueued > 0) && env.CACHE) await bustAlbum(env.CACHE, album.slug);

  const result = { fetched: candidates.length, enqueued, adopted, skipped: plan.skipped.length };
  console.log(`album import ${album.slug}: ${JSON.stringify(result)}`);
  return result;
}
