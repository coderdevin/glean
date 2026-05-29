import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { readAdminForm } from "~/lib/adminForm";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const form = await readAdminForm(ctx.request);

  // Editor rejection — stored plain. AI-pipeline failures are a separate
  // 'failed' status (see markFailed), so no reason-prefix sniffing is needed.
  const userReason = form.reject_reason?.trim();
  const reason = userReason || "rejected by editor";

  await db(env.DB).update(submissions).set({
    status: "rejected",
    rejectReason: reason,
    reviewedAt: new Date(),
  }).where(eq(submissions.id, id));

  // Log a pipeline event so the timeline shows WHO rejected and WHY. Before
  // this, admin clicks were invisible in the events log — combined with the
  // auto-unreject in runSectionsPhase, status would flip rejected→ready with
  // no trace of the rejection ever happening.
  await logEvent(env, id, "pipeline", "rejected", {
    message: reason,
    meta: { source: "admin-reject" },
  });

  return new Response(null, { status: 303, headers: { Location: "/admin" } });
};
