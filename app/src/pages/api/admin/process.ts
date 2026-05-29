/**
 * Admin "re-run AI" trigger — runs the LLM stage only. The submission must
 * already have a rawR2Key (i.e. extract stage completed previously). For a
 * full re-extract the editor should use /api/admin/[id]/refetch instead.
 *
 * In production this enqueues to the `glean-llm` queue (consumed by
 * workers/llm-consumer). In local dev, the queue consumer isn't running
 * inside Astro, so proxy to `wrangler dev workers/llm-consumer` on 8788.
 *
 * POST /api/admin/process            → re-run oldest extracted-but-unfinished
 * POST /api/admin/process?id=<ULID>  → re-run specific submission
 */

import type { APIRoute } from "astro";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const url = new URL(ctx.request.url);
  // The admin re-run buttons are `<form>` submit buttons that send both
  // `id` and `model` as form fields; CLI / scripts may use query params.
  // Read both, with form body taking precedence (more explicit).
  let explicitId = url.searchParams.get("id");
  let modelOverride = url.searchParams.get("model");
  if (ctx.request.headers.get("content-type")?.includes("form")) {
    try {
      const fd = await ctx.request.clone().formData();
      const fId = fd.get("id");
      const fModel = fd.get("model");
      if (typeof fId === "string" && fId) explicitId = fId;
      if (typeof fModel === "string" && fModel) modelOverride = fModel;
    } catch { /* not a form */ }
  }

  let targetId = explicitId;
  if (!targetId) {
    const oldest = await db(env.DB)
      .select({ id: submissions.id })
      .from(submissions)
      .where(inArray(submissions.status, ["pending", "analyzing", "composing"]))
      .orderBy(asc(submissions.createdAt))
      .limit(1);
    targetId = oldest[0]?.id ?? null;
  }

  if (!targetId) {
    return json({ ok: false, error: "no pending submission" }, 404);
  }

  // Reset row state so processLlm's idempotency guard doesn't short-circuit
  // an intentional rerun (the admin "Re-run V4-Pro / V4-Flash" buttons must
  // re-process even if the row already reached `ready` or got marked
  // `rejected`). Mirrors what /paste and /refetch do.
  await db(env.DB)
    .update(submissions)
    .set({
      status: "pending",
      rejectReason: null,
      processedAt: null,
      processingStartedAt: new Date(),
      processingModel: modelOverride || "deepseek-v4-pro",
    })
    .where(eq(submissions.id, targetId));

  if (import.meta.env.DEV) {
    await logEvent(env, targetId, "queue", "queued", {
      message: modelOverride ? `admin re-run ${modelOverride} (dev)` : "admin re-run (dev)",
      meta: { target: "glean-llm", source: "admin-rerun-dev", model: modelOverride ?? undefined },
    });
    // Proxy to the locally-running LLM-stage worker.
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", targetId);
    if (modelOverride) proxyUrl.searchParams.set("model", modelOverride);
    try {
      const res = await fetch(proxyUrl.toString(), { method: "POST" });
      const body = await res.text();
      if (res.ok && ctx.request.headers.get("accept")?.includes("text/html")) {
        return new Response(null, { status: 303, headers: { Location: `/admin/${targetId}` } });
      }
      return new Response(body, {
        status: res.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      return json(
        {
          ok: false,
          error:
            "llm-consumer worker not reachable. Start it with `pnpm llm:dev` " +
            `(expected at ${LLM_WORKER_URL}). Underlying: ${(err as Error).message}`,
        },
        503,
      );
    }
  }

  // Production: enqueue to the LLM-stage queue. The model override is
  // encoded into the queue message (worker parses ULID + optional |model=).
  // Extract is skipped — rawR2Key is expected to be set from a prior run.
  const payload = modelOverride ? `${targetId}|model=${modelOverride}` : targetId;
  await env.INGEST_LLM.send(payload);
  await logEvent(env, targetId, "queue", "queued", {
    message: modelOverride ? `admin re-run ${modelOverride}` : "admin re-run",
    meta: { target: "glean-llm", source: "admin-rerun", model: modelOverride ?? undefined },
  });
  // Browser form submissions: redirect back to the admin detail so the editor
  // sees the status flip instead of a raw JSON dump. CLI / fetch callers (no
  // Accept: text/html) still get JSON. `?queued=<model>` lets the page show
  // a "just enqueued" flash banner above the processing card.
  if (ctx.request.headers.get("accept")?.includes("text/html")) {
    const q = encodeURIComponent(modelOverride || "enqueued");
    return new Response(null, { status: 303, headers: { Location: `/admin/${targetId}?queued=${q}` } });
  }
  return json({ ok: true, queued: targetId, stage: "llm", modelOverride });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
