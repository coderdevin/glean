import type { APIRoute } from "astro";
import { z } from "zod";
import { rateLimit } from "~/lib/ratelimit";
import { signOtpChallenge, generateOtpCode, normalizeEmail } from "~/lib/reader-auth";
import { emailEnabled, sendEmail } from "~/lib/email";
import { renderOtpEmail } from "~/lib/email-templates";

export const prerender = false;

const Body = z.object({
  email: z.string().email().max(200),
  lang: z.enum(["zh", "en"]).optional(),
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
  const email = normalizeEmail(parsed.data.email);

  // Rate-limit by IP so codes can't be used to spam an inbox.
  const rl = await rateLimit(env.CACHE, "reader-login", 5, 3600, ip);
  if (!rl.ok) return json({ ok: false, error: "rate limit" }, 429);

  const lang = parsed.data.lang ?? (ctx.locals.lang as "zh" | "en") ?? "zh";
  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const code = generateOtpCode();
  // The challenge is opaque (carries only a keyed hash of the code) — safe to
  // return to the client, which holds it and submits it with the typed code.
  const challenge = await signOtpChallenge(secret, email, code);

  const sent = emailEnabled(env);
  if (sent) {
    const mail = renderOtpEmail({ lang, siteName: env.SITE_NAME || "Glean", code });
    const res = await sendEmail(env, {
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!res.ok) console.error("login code email send failed", res.error);
  } else {
    // Local dev without a provider key: log the code so login still works.
    console.log(`[reader-login] code for ${email}: ${code}`);
  }

  // Passwordless: login and signup are the same path (the reader row is created
  // on first successful verify), so there's no account to enumerate. The code
  // is always emailed; the per-IP rate limit above bounds inbox-spam abuse.
  return json({ ok: true, challenge, sent });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
