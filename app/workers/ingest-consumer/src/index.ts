/**
 * Glean extract-stage worker.
 *
 * Consumes the `glean-ingest` queue. For each message:
 *   1. Run processExtract() — fetch URL (or use R2 cache) + stash raw text.
 *   2. On success, enqueue the same ULID to `glean-llm` so the LLM worker
 *      picks up where we left off.
 *
 * Failure semantics:
 *   - transient (fetch timeout, 5xx, network) → msg.retry up to 2x
 *   - third attempt fails → markFailed + ack (DLQ-able)
 *   - LLM-stage errors live in workers/llm-consumer, not here
 *
 * Two entry points:
 *   queue() — production: Cloudflare Queue consumer
 *   fetch() — dev / manual triggering:
 *     POST /process?id=<ULID>   process one specific submission
 *     POST /process             process the oldest pending submission
 *
 * Local dev shares the .wrangler/state directory with the Astro dev
 * server, so submissions inserted via /api/submit are visible here.
 */

import { processExtract, markFailed, logEvent, type ExtractEnv } from "../../../src/lib/ingest";
import { drizzle } from "drizzle-orm/d1";
import { asc, inArray } from "drizzle-orm";
import { submissions } from "../../../src/db/schema";

export interface Env extends ExtractEnv {}

export default {
  async queue(batch: MessageBatch<string>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const id = msg.body;
      try {
        const result = await processExtract(env, id);
        console.log("extract ok", result);
        // Hand off to the LLM stage.
        await env.INGEST_LLM.send(id);
        await logEvent(env, id, "queue", "queued", {
          message: "forwarded to glean-llm",
          meta: { target: "glean-llm" },
        });
        msg.ack();
      } catch (err) {
        const reason = (err as Error).message ?? "unknown extract error";
        console.error("extract fail", { id, reason, attempts: msg.attempts });
        await logEvent(env, id, "extract", "failed", {
          message: reason,
          meta: { attempts: msg.attempts },
        });
        // CF Queues sets msg.attempts=1 on first delivery and increments on
        // each retry. wrangler max_retries=2 allows 3 total deliveries
        // (initial + 2 retries) — match that here, not `>= 2` which gave
        // only 1 retry.
        if (msg.attempts >= 3) {
          await markFailed(env, id, "extract", reason).catch((e) =>
            console.error("markFailed failed", e),
          );
          msg.ack();
        } else {
          msg.retry({ delaySeconds: 30 });
        }
      }
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/process") {
      const explicitId = url.searchParams.get("id");
      let targetId = explicitId;
      if (!targetId) {
        const db = drizzle(env.DB);
        const row = await db
          .select({ id: submissions.id })
          .from(submissions)
          .where(inArray(submissions.status, ["pending", "analyzing", "composing"]))
          .orderBy(asc(submissions.createdAt))
          .limit(1);
        targetId = row[0]?.id ?? null;
      }
      if (!targetId) {
        return json({ ok: false, error: "no pending submission" }, 404);
      }
      try {
        const result = await processExtract(env, targetId);
        await env.INGEST_LLM.send(targetId);
        await logEvent(env, targetId, "queue", "queued", {
          message: "forwarded to glean-llm",
          meta: { target: "glean-llm" },
        });
        return json({ ok: true, stage: "extract", result, forwarded_to: "glean-llm" });
      } catch (err) {
        const reason = (err as Error).message ?? "unknown";
        await logEvent(env, targetId, "extract", "failed", {
          message: reason,
          meta: { attempts: 1, source: "fetch-handler" },
        });
        await markFailed(env, targetId, "extract", reason).catch(() => {});
        return json({ ok: false, id: targetId, error: reason }, 500);
      }
    }
    return new Response("glean-ingest (extract) worker: POST /process[?id=<ULID>]", { status: 200 });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
