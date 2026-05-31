/**
 * Save or reset an editable system prompt (persisted in app_settings, read by
 * the LLM-stage worker per call via resolvePrompt). Admin-only — gated by
 * middleware.
 *
 * POST /api/admin/settings/prompt
 *   form: key=<PromptKey>  value=<text>  [action=reset]
 *
 * `action=reset` (or a blank value) deletes the override row, so the pipeline
 * falls back to the baked-in default in llm.ts. The key MUST be one of the
 * PROMPT_REGISTRY keys — arbitrary app_settings writes are rejected.
 */
import type { APIRoute } from "astro";
import { PROMPT_REGISTRY } from "~/lib/llm";
import { deleteSetting, setSetting } from "~/lib/settings";

export const prerender = false;

const VALID_KEYS = new Set<string>(PROMPT_REGISTRY.map((p) => p.key));

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;

  let key = "";
  let value = "";
  let reset = false;
  try {
    const fd = await ctx.request.formData();
    key = String(fd.get("key") ?? "").trim();
    value = String(fd.get("value") ?? "");
    reset = String(fd.get("action") ?? "") === "reset";
  } catch {
    return new Response("expected form data", { status: 400 });
  }

  if (!VALID_KEYS.has(key)) {
    return new Response(`unknown prompt key "${key}"`, { status: 400 });
  }

  if (reset || !value.trim()) {
    await deleteSetting(env.DB, key);
  } else {
    await setSetting(env.DB, key, value);
  }

  const back = ctx.request.headers.get("referer") || "/admin/settings";
  return new Response(null, { status: 303, headers: { Location: back } });
};
