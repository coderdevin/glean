import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { successView } from "~/lib/submissionStatus";

export const prerender = false;

// Public, read-only status lookup for the /submit/success page. Returns the
// same SuccessView the page renders server-side, so the client can poll and
// update in place instead of doing a full-page meta-refresh (which wiped the
// "notify me" email input every few seconds). Keyed by the 26-char ULID, which
// is effectively unguessable, so no auth is needed; data exposed is only the
// coarse status + already-public copy.
export const GET: APIRoute = async (ctx) => {
  const id = ctx.url.searchParams.get("id");
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });

  if (!id || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return json({ error: "bad_id" }, 400);

  const env = ctx.locals.runtime.env;
  const rows = await db(env.DB)
    .select({
      status: submissions.status,
      rejectReason: submissions.rejectReason,
      linkedPickId: submissions.linkedPickId,
    })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return json({ error: "not_found" }, 404);

  return json(successView(row), 200);
};
