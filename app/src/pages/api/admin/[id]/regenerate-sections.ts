/**
 * Admin: re-run the sections phase for a submission whose analysis already
 * succeeded but whose sections pass failed (or, for a published row, an
 * editor wants to rebuild the body).
 *
 * Architecture: Cloudflare Pages SSR has a ~30 second wall-clock cap; the
 * real sections call is a 2–4 minute V4-Pro stream. We can't await it here.
 * Instead, set status='composing', enqueue a `phase=sections` message to the
 * llm-consumer queue, and return 303 immediately. The worker (15 min wall
 * time) picks up the message and runs runSectionsPhase.
 *
 * Guard: isInFlight(status) blocks while the pipeline is running
 * (pending/analyzing/composing). ready/failed/published/rejected may
 * (re)generate sections.
 *
 * Dev mode: the Pages app proxies straight to the local llm-consumer
 * fetch handler the same way paste.ts does — wrangler's queue producer
 * binding works locally too, but the proxy gives immediate execution
 * without waiting for the dev queue poller.
 *
 * Auth: gated by the /api/admin middleware. No additional check needed.
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { logEvent } from "~/lib/ingest";
import { isInFlight } from "~/lib/submissionStatus";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

// Optional sections model override (provider × tier). Empty/absent → the active
// provider's Flash default (unchanged behavior). Allowlisted so the admin form
// can't inject an arbitrary provider spec downstream. Specs resolve via
// resolveProviderSpec (llm.ts): bare "deepseek-*" → DeepSeek API; "modelscope:…"
// → ModelScope (free quota). Flash = fast/cheap; Pro = reasoning model, slower
// but higher quality (e.g. GitHub project explainers read better on Pro).
// ModelScope only serves Flash — V4-Pro 400s there ("no provider supported"),
// so Pro is offered via the paid DeepSeek API only.
const SECTIONS_MODEL_SPECS = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "modelscope:deepseek-ai/DeepSeek-V4-Flash",
]);

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  // Optional model picker from the regenerate form; ignore anything off-list.
  const form = await ctx.request.formData().catch(() => null);
  const modelRaw = (form?.get("model") ?? "").toString().trim();
  const model = SECTIONS_MODEL_SPECS.has(modelRaw) ? modelRaw : undefined;

  const sRows = await db(env.DB).select().from(submissions).where(eq(submissions.id, id)).limit(1);
  const sub = sRows[0];
  if (!sub) return new Response("not found", { status: 404 });
  if (!sub.rawR2Key) {
    return new Response("no extracted body — run extract first", { status: 409 });
  }
  // Block while the pipeline is still running (pending/analyzing/composing);
  // allow ready / failed / published / rejected to (re)generate sections.
  if (isInFlight(sub.status)) {
    return new Response(
      `cannot regenerate sections: pipeline is busy (status=${sub.status})`,
      { status: 409 },
    );
  }

  if (sub.status !== "published") {
    await db(env.DB)
      .update(submissions)
      // Reset the stall clock so the reaper measures from this regenerate,
      // not the original analysis run hours ago (else it reaps within minutes).
      .set({ status: "composing", failureStage: null, aiSectionsError: null, processingStartedAt: new Date() })
      .where(eq(submissions.id, id));
  }
  await logEvent(env, id, "queue", "queued", {
    message: "sections regenerate requested by admin",
    meta: { target: "glean-llm", source: "regenerate", phase: "sections", model: model ?? "default(flash)" },
  });

  const msgBody = model ? `${id}|phase=sections&model=${model}` : `${id}|phase=sections`;
  if (import.meta.env.DEV) {
    // Dev: proxy directly to the local llm-consumer fetch handler so the
    // sections call fires without waiting for the dev queue poller.
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    proxyUrl.searchParams.set("phase", "sections");
    if (model) proxyUrl.searchParams.set("model", model);
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(msgBody);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/${id}` } });
};
