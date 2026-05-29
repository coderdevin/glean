/**
 * Admin: paste raw article content for a submission whose URL we couldn't
 * extract (paywall / JS-only / 404).
 *
 * Writes the body to R2, marks the submission pending, then enqueues to the
 * **LLM stage** directly — extract has effectively been "completed by hand".
 * Returns 303 immediately so the editor doesn't watch the spinner during
 * the 30-240s LLM reasoning.
 *
 * In Astro dev there's no queue consumer running inside Vite — proxy to
 * `wrangler dev workers/llm-consumer` on port 8788.
 */
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "~/db/client";
import { submissions } from "~/db/schema";
import { logEvent } from "~/lib/ingest";

export const prerender = false;

const LLM_WORKER_URL = "http://localhost:8788";

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const fd = await ctx.request.formData();
  const content = String(fd.get("content") ?? "").trim();
  const manualTitle = String(fd.get("manual_title") ?? "").trim();

  if (content.length < 200) {
    return new Response(`content too short (need ≥ 200 chars, got ${content.length})`, { status: 400 });
  }

  const rawKey = `raw/${id}.txt`;
  await env.RAW.put(rawKey, content, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    // Stash the editor-provided title (if any) on the R2 object — processLlm
    // reads customMetadata.title as the LLM's title seed when row.aiTitleEn
    // is empty.
    customMetadata: {
      source: "manual-paste",
      ...(manualTitle ? { title: manualTitle.slice(0, 256) } : {}),
    },
  });

  await db(env.DB)
    .update(submissions)
    .set({
      status: "pending",
      rawR2Key: rawKey,
      rejectReason: null,
      // Clear stale failure metadata from a prior failed run.
      failureStage: null,
      aiSectionsError: null,
      processedAt: null,
      processingStartedAt: new Date(),
      processingModel: "deepseek-v4-pro",
      // Also seed ai_title_en directly so the LLM has it even if R2 metadata
      // is unavailable / cleared later.
      ...(manualTitle ? { aiTitleEn: manualTitle.slice(0, 256) } : {}),
    })
    .where(eq(submissions.id, id));

  await logEvent(env, id, "extract", "skipped", {
    message: "manual paste",
    meta: { chars: content.length, hasManualTitle: !!manualTitle },
  });
  await logEvent(env, id, "queue", "queued", {
    message: "manual paste enqueued",
    meta: { target: "glean-llm", source: "paste" },
  });

  if (import.meta.env.DEV) {
    // Proxy to the local llm-consumer dev worker.
    const proxyUrl = new URL(`${LLM_WORKER_URL}/process`);
    proxyUrl.searchParams.set("id", id);
    fetch(proxyUrl.toString(), { method: "POST" }).catch((err) =>
      console.warn("dev llm proxy fire-and-forget failed:", (err as Error).message),
    );
  } else {
    await env.INGEST_LLM.send(id);
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/${id}` } });
};
