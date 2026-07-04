/** Admin: create a new album (draft). Slug is derived from the title + a short
 *  id suffix so it's unique, mirroring publish.ts slug shape. */
import type { APIRoute } from "astro";
import { db } from "~/db/client";
import { albums } from "~/db/schema";
import { ulid } from "~/lib/ulid";
import { slugify } from "~/lib/adminForm";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
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
  const id = ulid();
  const slug = `${slugify(str("slug") || titleEn || titleZh)}-${id.slice(-6).toLowerCase()}`;
  await db(env.DB)
    .insert(albums)
    .values({
      id,
      slug,
      titleZh,
      titleEn,
      introZh: str("intro_zh") || null,
      introEn: str("intro_en") || null,
      feedUrl: str("feed_url") || null,
      status: "draft",
      createdAt: new Date(),
    });
  return new Response(null, { status: 303, headers: { Location: `/admin/albums` } });
};
