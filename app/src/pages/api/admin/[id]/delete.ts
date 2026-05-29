/**
 * Admin: hard-delete a submission and everything attached to it.
 * Cascade order: pick_tags → article_annotations → picks → R2 raw → submission.
 * Use this for spam / duplicate / wrong-URL submissions. For "we won't run
 * this one" but want to keep an audit trail, use /reject instead.
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import {
  submissions,
  picks,
  pickTags,
  articleAnnotations,
} from "~/db/schema";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const drizzle = db(env.DB);
  const rows = await drizzle.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const sub = rows[0];
  if (!sub) return new Response("not found", { status: 404 });

  const pickId = sub.linkedPickId;
  if (pickId) {
    await drizzle.delete(pickTags).where(eq(pickTags.pickId, pickId));
    await drizzle.delete(articleAnnotations).where(eq(articleAnnotations.pickId, pickId));
    await drizzle.delete(picks).where(eq(picks.id, pickId));
  }

  if (sub.rawR2Key) {
    await env.RAW.delete(sub.rawR2Key).catch((e) =>
      console.warn("R2 delete failed (ignored)", e),
    );
  }

  await drizzle.delete(submissions).where(eq(submissions.id, id));

  return new Response(null, { status: 303, headers: { Location: "/admin" } });
};
