/**
 * Save or reset the topic-relevance gate settings (persisted in app_settings,
 * read by the LLM-stage worker per submission). Admin-only — gated by
 * middleware.
 *
 * POST /api/admin/settings/relevance
 *   form: charter=<text>  threshold=<0..1>  [action=reset]
 *
 * `action=reset` deletes BOTH override rows, so the pipeline falls back to the
 * baked-in DEFAULT_RELEVANCE_CHARTER (llm.ts) and RELEVANCE_SCORE_THRESHOLD
 * (ingest.ts). A blank charter deletes just the charter override; an
 * out-of-range / non-numeric threshold is rejected (no silent clamp).
 */
import type { APIRoute } from "astro";
import { RELEVANCE_CHARTER_KEY } from "~/lib/llm";
import { RELEVANCE_THRESHOLD_KEY } from "~/lib/ingest";
import { deleteSetting, setSetting } from "~/lib/settings";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const back = ctx.request.headers.get("referer") || "/admin/settings";

  let charter = "";
  let thresholdRaw = "";
  let reset = false;
  try {
    const fd = await ctx.request.formData();
    charter = String(fd.get("charter") ?? "");
    thresholdRaw = String(fd.get("threshold") ?? "").trim();
    reset = String(fd.get("action") ?? "") === "reset";
  } catch {
    return new Response("expected form data", { status: 400 });
  }

  if (reset) {
    await deleteSetting(env.DB, RELEVANCE_CHARTER_KEY);
    await deleteSetting(env.DB, RELEVANCE_THRESHOLD_KEY);
    return new Response(null, { status: 303, headers: { Location: back } });
  }

  // Threshold: must be a number in [0,1] when provided; blank falls back to default.
  if (thresholdRaw) {
    const n = Number(thresholdRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return new Response(`threshold must be a number in [0,1], got "${thresholdRaw}"`, { status: 400 });
    }
    await setSetting(env.DB, RELEVANCE_THRESHOLD_KEY, String(n));
  } else {
    await deleteSetting(env.DB, RELEVANCE_THRESHOLD_KEY);
  }

  if (charter.trim()) {
    await setSetting(env.DB, RELEVANCE_CHARTER_KEY, charter);
  } else {
    await deleteSetting(env.DB, RELEVANCE_CHARTER_KEY);
  }

  return new Response(null, { status: 303, headers: { Location: back } });
};
