import type { APIRoute } from "astro";
import { z } from "zod";
import { db } from "~/db/client";
import { subscribers } from "~/db/schema";
import { verifyTurnstile } from "~/lib/turnstile";
import { rateLimit } from "~/lib/ratelimit";
import { signToken } from "~/lib/auth";
import { emailEnabled, sendEmail } from "~/lib/email";
import { renderConfirmEmail } from "~/lib/email-templates";

export const prerender = false;

const Body = z.object({
  email: z.string().email().max(200),
  source: z.string().max(40).default("unknown"),
  lang: z.enum(["zh", "en"]).optional(),
  "cf-turnstile-response": z.string().optional(),
});

export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const ip = ctx.request.headers.get("cf-connecting-ip") ?? "0.0.0.0";

  let raw: Record<string, string> = {};
  const ct = ctx.request.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await ctx.request.formData();
    for (const [k, v] of fd.entries()) raw[k] = typeof v === "string" ? v : "";
  } else {
    try { raw = (await ctx.request.json()) as Record<string, string>; }
    catch { return json({ ok: false, error: "bad request" }, 400); }
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return json({ ok: false, error: "invalid email" }, 400);
  const { email, source, lang } = parsed.data;

  const tsToken = parsed.data["cf-turnstile-response"];
  if (tsToken) {
    const tsOk = await verifyTurnstile(env.TURNSTILE_SECRET ?? "", tsToken, ip);
    if (!tsOk) return json({ ok: false, error: "human check failed" }, 400);
  }

  const rl = await rateLimit(env.CACHE, "subscribe", 5, 3600, ip);
  if (!rl.ok) return json({ ok: false, error: "rate limit" }, 429);

  const langPref = lang ?? (ctx.locals.lang as "zh" | "en") ?? "zh";
  const token = await signToken(env.COOKIE_SIGNING_KEY || "dev-key-please-set", {
    e: email.toLowerCase(),
    t: Date.now(),
  });

  try {
    await db(env.DB).insert(subscribers).values({
      email: email.toLowerCase(),
      langPref,
      source,
      confirmToken: token,
      confirmedAt: null,
      unsubscribedAt: null,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: subscribers.email,
      // Re-subscribing clears a prior opt-out and re-arms the confirm token.
      set: { langPref, source, confirmToken: token, unsubscribedAt: null },
    });
  } catch (err) {
    console.error("subscribe insert failed", err);
    return json({ ok: false, error: "server" }, 500);
  }

  // Double opt-in: email the confirmation link. Best-effort — a send failure
  // must not 500 the signup (the row exists; the editor can re-trigger). When
  // no provider key is configured (local dev), needsConfirm is false so the UI
  // shows a generic "you're on the list" instead of "check your inbox".
  const needsConfirm = emailEnabled(env);
  if (needsConfirm) {
    const base = (env.SITE_URL || "").replace(/\/$/, "");
    const confirmUrl = `${base}/api/subscribe/confirm?t=${encodeURIComponent(token)}`;
    const mail = renderConfirmEmail({
      lang: langPref,
      siteName: env.SITE_NAME || "Glean",
      confirmUrl,
    });
    const res = await sendEmail(env, {
      to: email.toLowerCase(),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!res.ok) console.error("confirm email send failed", res.error);
  }

  return json({ ok: true, needsConfirm });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
