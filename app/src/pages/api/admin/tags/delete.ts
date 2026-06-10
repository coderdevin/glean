/**
 * Admin: delete an orphan tag (zero pick references). Refuses to delete a tag
 * that any pick (published or draft) still carries — the taxonomy self-grows
 * on publish, so deleting unused entries is safe housekeeping, deleting used
 * ones never is.
 *
 * form: slug=<tag slug>
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { tags, pickTags } from "~/db/schema";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;

  let slug = "";
  try {
    const fd = await ctx.request.formData();
    slug = String(fd.get("slug") ?? "").trim();
  } catch {
    return new Response("expected form data", { status: 400 });
  }
  if (!slug) return new Response("missing slug", { status: 400 });

  const drizzleDb = db(env.DB);
  const refs = await drizzleDb
    .select({ pickId: pickTags.pickId })
    .from(pickTags)
    .where(eq(pickTags.tagSlug, slug))
    .limit(1);
  if (refs.length > 0) {
    return new Response(`tag "${slug}" is still referenced by picks — not deleting`, { status: 409 });
  }

  await drizzleDb.delete(tags).where(eq(tags.slug, slug));
  return new Response(null, { status: 303, headers: { Location: "/admin/wiki" } });
};
