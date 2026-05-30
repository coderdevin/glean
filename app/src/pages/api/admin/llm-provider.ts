/**
 * Set the global default LLM provider (persisted in app_settings, read by the
 * LLM-stage worker per batch). Admin-only — gated by middleware.
 *
 * POST /api/admin/llm-provider   body/query: provider=modelscope|deepseek|openai|auto
 *
 * Affects the AUTOMATIC pipeline (new submissions) + any re-run that doesn't
 * carry an explicit per-run provider override. "auto" follows the env default.
 */
import type { APIRoute } from "astro";
import { isLlmProviderSetting, setLlmProviderSetting } from "~/lib/settings";

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const url = new URL(ctx.request.url);

  let provider = url.searchParams.get("provider") ?? "";
  const isForm = ctx.request.headers.get("content-type")?.includes("form");
  if (isForm) {
    try {
      const fd = await ctx.request.clone().formData();
      const v = fd.get("provider");
      if (typeof v === "string") provider = v;
    } catch { /* not a form */ }
  }
  provider = provider.trim().toLowerCase();

  if (!isLlmProviderSetting(provider)) {
    return json({ ok: false, error: `invalid provider "${provider}"` }, 400);
  }

  await setLlmProviderSetting(env.DB, provider);

  // Form submit from the admin UI → redirect back so the toggle re-renders.
  if (isForm || ctx.request.headers.get("accept")?.includes("text/html")) {
    const back = ctx.request.headers.get("referer") || "/admin";
    return new Response(null, { status: 303, headers: { Location: back } });
  }
  return json({ ok: true, provider }, 200);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
