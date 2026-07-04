/** Admin: edit an album's bilingual title/intro + feed URL. */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { albums } from "~/db/schema";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const form = await ctx.request.formData().catch(() => null);
  const str = (k: string): string => {
    const v = form?.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const titleZh = str("title_zh");
  const titleEn = str("title_en");
  if (!titleZh || !titleEn) {
    return new Response("title_zh + title_en required", { status: 422 });
  }
  await db(env.DB)
    .update(albums)
    .set({
      titleZh,
      titleEn,
      introZh: str("intro_zh") || null,
      introEn: str("intro_en") || null,
      feedUrl: str("feed_url") || null,
    })
    .where(eq(albums.id, id));
  return new Response(null, { status: 303, headers: { Location: `/admin/albums` } });
};
