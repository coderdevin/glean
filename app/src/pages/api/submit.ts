import type { APIRoute } from "astro";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "~/lib/ulid";
import { z } from "zod";
import { db } from "~/db/client";
import { submissions, picks } from "~/db/schema";
import { verifyTurnstile } from "~/lib/turnstile";
import { rateLimit, ipHash } from "~/lib/ratelimit";
import { normalizeUrl } from "~/lib/normalize-url";
import { logEvent } from "~/lib/ingest";
import { buildSubmitError } from "~/lib/submitError";

export const prerender = false;

const Body = z.object({
  url: z.string().url().max(2048),
  note: z.string().max(500).optional().nullable(),
  submitter: z.string().max(40).optional().nullable(),
  website: z.string().optional().nullable(),
  "cf-turnstile-response": z.string().optional(),
});

function redirectTo(path: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: path } });
}

export const POST: APIRoute = async (ctx) => {
  try {
    return await handleSubmit(ctx);
  } catch (err) {
    const e = err as Error;
    console.error("submit handler crashed", e.message, e.stack);
    // In DEV surface the stack + which bindings exist (mis-binding is the
    // most common cause). In production return only a generic 500 — the
    // stack and binding map are recon material for attackers.
    if (import.meta.env.DEV) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: e.message ?? String(err),
          stack: e.stack?.split("\n").slice(0, 8),
          bindings_present: {
            DB: !!ctx.locals.runtime?.env?.DB,
            CACHE: !!ctx.locals.runtime?.env?.CACHE,
            INGEST: !!ctx.locals.runtime?.env?.INGEST,
            RAW: !!ctx.locals.runtime?.env?.RAW,
            TURNSTILE_SECRET: !!ctx.locals.runtime?.env?.TURNSTILE_SECRET,
          },
        }, null, 2),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    return new Response(
      JSON.stringify({ ok: false, error: "server" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
};

async function handleSubmit(ctx: Parameters<APIRoute>[0]): Promise<Response> {
  const env = ctx.locals.runtime.env;
  const ip = ctx.request.headers.get("cf-connecting-ip") ?? "0.0.0.0";

  let raw: Record<string, string>;
  const ct = ctx.request.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await ctx.request.formData();
    raw = {};
    for (const [k, v] of fd.entries()) {
      raw[k] = typeof v === "string" ? v : "";
    }
  } else {
    try { raw = (await ctx.request.json()) as Record<string, string>; }
    catch { return redirectTo(buildSubmitError("bad_url"), 303); }
  }

  const parsed = Body.safeParse(raw);
  // Echo back the raw url/note so a bad URL can be corrected in place rather
  // than retyped — the zod parse failed, so parsed.data isn't available here.
  if (!parsed.success) {
    return redirectTo(buildSubmitError("bad_url", { url: raw.url, note: raw.note }), 303);
  }
  const { url, note, submitter, website } = parsed.data;

  if (website && website.length > 0) {
    return redirectTo("/submit?error=honeypot", 303);
  }

  // Turnstile only applies to browser-form submissions (where it's free —
  // the widget runs invisibly on /submit). JSON API submissions skip it; the
  // 10/IP/hour rate limit + human review on every pick are the abuse floor.
  // No private token, no "ask the editor" — anyone can curl the API.
  const isJsonApi = ct.includes("application/json");
  const tsToken = parsed.data["cf-turnstile-response"];
  const devBypass = import.meta.env.DEV && !env.TURNSTILE_SECRET;
  if (!devBypass && !isJsonApi) {
    const tsOk = await verifyTurnstile(env.TURNSTILE_SECRET ?? "", tsToken ?? null, ip);
    if (!tsOk) return redirectTo(buildSubmitError("turnstile", { url, note }), 303);
  }

  const rl = await rateLimit(env.CACHE, "submit", 10, 3600, ip);
  if (!rl.ok) return redirectTo(buildSubmitError("rate_limit", { url, note }), 303);

  const normalized = normalizeUrl(url);

  // Dedup: same URL already in flight or already published as a pick.
  // Rejected submissions don't block — give the URL another chance.
  const existing = await db(env.DB)
    .select({ id: submissions.id, status: submissions.status, linkedPickId: submissions.linkedPickId })
    .from(submissions)
    .where(
      and(
        eq(submissions.url, normalized),
        inArray(submissions.status, ["pending", "analyzing", "composing", "ready", "published"]),
      ),
    )
    .limit(1);
  if (existing[0]) {
    const ex = existing[0];
    if (ex.status === "published" && ex.linkedPickId) {
      const pick = await db(env.DB)
        .select({ slug: picks.slug })
        .from(picks)
        .where(eq(picks.id, ex.linkedPickId))
        .limit(1);
      if (pick[0]) return redirectTo(`/a/${pick[0].slug}`, 303);
    }
    return redirectTo(`/submit/success?id=${ex.id}&dup=1`, 303);
  }

  // Cover seeded picks that have no matching submission row.
  const existingPick = await db(env.DB)
    .select({ slug: picks.slug })
    .from(picks)
    .where(eq(picks.sourceUrl, normalized))
    .limit(1);
  if (existingPick[0]) return redirectTo(`/a/${existingPick[0].slug}`, 303);

  const id = ulid();
  const hash = await ipHash(ip);

  try {
    await db(env.DB).insert(submissions).values({
      id,
      url: normalized,
      note: note ?? null,
      submitterName: submitter?.trim() || null,
      submitterIpHash: hash,
      status: "pending",
      processingStartedAt: new Date(),
      processingModel: "extract",
      createdAt: new Date(),
    });
    await env.INGEST.send(id);
    await logEvent(env, id, "queue", "queued", {
      message: "new submission",
      meta: { target: "glean-ingest", source: "submit-form" },
    });
  } catch (err) {
    console.error("submit insert/enqueue failed", err);
    return redirectTo(buildSubmitError("server", { url, note }), 303);
  }

  return redirectTo(`/submit/success?id=${id}`, 303);
}
