/**
 * Admin: roll the live wiki back to a previous version.
 *
 * Non-destructive: "newest generated_at wins" is the publish rule, so rolling
 * back = inserting a COPY of the chosen version with a fresh timestamp. The
 * full history (including the rolled-away version) stays queryable, and a
 * rollback can itself be rolled back.
 *
 * form: id=<wiki_index id>
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { wikiIndex } from "~/db/schema";
import { logEvent } from "~/lib/ingest";
import { ulid } from "~/lib/ulid";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;

  let id = "";
  try {
    const fd = await ctx.request.formData();
    id = String(fd.get("id") ?? "").trim();
  } catch {
    return new Response("expected form data", { status: 400 });
  }
  if (!id) return new Response("missing id", { status: 400 });

  const drizzleDb = db(env.DB);
  const rows = await drizzleDb.select().from(wikiIndex).where(eq(wikiIndex.id, id)).limit(1);
  const row = rows[0];
  if (!row) return new Response(`wiki version ${id} not found`, { status: 404 });

  const now = new Date();
  await drizzleDb.insert(wikiIndex).values({
    id: ulid(),
    introZh: row.introZh,
    introEn: row.introEn,
    topicsJson: row.topicsJson,
    model: row.model,
    picksCount: row.picksCount,
    generatedAt: now,
    createdAt: now,
  });

  await logEvent(env, "wiki", "llm", "ok", {
    message: `wiki rolled back to version ${id} (${row.picksCount} picks, ${new Date(row.generatedAt).toISOString().slice(0, 10)})`,
    meta: { kind: "wiki", source: "wiki-rollback", restored: id },
  });

  return new Response(null, { status: 303, headers: { Location: "/admin/wiki" } });
};
