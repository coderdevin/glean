import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  // Clear the cached extract so the worker actually refetches the URL.
  // Without this, loadBody() would shortcut to the existing R2 object and
  // "重新抓取" would silently re-run only the LLM step.
  await db(env.DB).update(submissions).set({
    status: "pending",
    processedAt: null,
    rejectReason: null,
    processingStartedAt: new Date(),
    processingModel: "extract",
    rawR2Key: null,
    extractedLang: null,
  }).where(eq(submissions.id, id));

  await env.INGEST.send(id);
  await logEvent(env, id, "queue", "queued", {
    message: "refetch requested by admin",
    meta: { target: "glean-ingest", source: "refetch" },
  });

  return new Response(null, { status: 303, headers: { Location: `/admin/${id}` } });
};
