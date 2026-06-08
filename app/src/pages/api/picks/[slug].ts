import type { APIRoute } from "astro";
import { db } from "~/db/client";
import { pickBySlug } from "~/lib/queries";

export const prerender = false;

// Public, read-only full view of one published pick — the bilingual body
// sections, glossary, next-hints, tags. Same data the /a/<slug> reader page
// renders. Powers the CLI `read` command and the body-fetch step of `ask`.
const CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

export const GET: APIRoute = async (ctx) => {
  const slug = ctx.params.slug;
  const json = (body: unknown, status: number, cache?: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": cache ?? "no-store",
      },
    });

  if (!slug) return json({ error: "bad_slug" }, 400);

  const env = ctx.locals.runtime.env;
  const pick = await pickBySlug(db(env.DB), slug);
  if (!pick) return json({ error: "not_found" }, 404);

  return json(pick, 200, CACHE);
};
