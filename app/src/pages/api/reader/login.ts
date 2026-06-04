import type { APIRoute } from "astro";
import { z } from "zod";
import { rateLimit } from "~/lib/ratelimit";
import { signLoginToken, normalizeEmail } from "~/lib/reader-auth";
import { emailEnabled, sendEmail } from "~/lib/email";
import { renderLoginEmail } from "~/lib/email-templates";

export const prerender = false;

const Body = z.object({
  email: z.string().email().max(200),
  lang: z.enum(["zh", "en"]).optional(),
  // Where to land after clicking the link. Must be a same-site path.
  next: z.string().max(300).optional(),
});

/** Only allow same-site relative paths as the post-login redirect target. */
function safeNext(next: string | undefined): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/me/notes";
}

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

  // Rate-limit by IP so the link can't be used to spam an inbox.
  const rl = await rateLimit(env.CACHE, "reader-login", 5, 3600, ip);
  if (!rl.ok) return json({ ok: false, error: "rate limit" }, 429);

  const lang = parsed.data.lang ?? (ctx.locals.lang as "zh" | "en") ?? "zh";
  const next = safeNext(parsed.data.next);
  const secret = env.COOKIE_SIGNING_KEY || "dev-key-please-set";
  const token = await signLoginToken(secret, email);

  const sent = emailEnabled(env);
  if (sent) {
    const base = (env.SITE_URL || "").replace(/\/$/, "");
    const loginUrl =
      `${base}/api/reader/verify?token=${encodeURIComponent(token)}` +
      `&next=${encodeURIComponent(next)}`;
    const mail = renderLoginEmail({ lang, siteName: env.SITE_NAME || "Glean", loginUrl });
    const res = await sendEmail(env, {
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!res.ok) console.error("login email send failed", res.error);
  } else {
    // Local dev without a provider key: log the link so login still works.
    const base = (env.SITE_URL || "").replace(/\/$/, "");
    console.log(`[reader-login] ${base}/api/reader/verify?token=${token}&next=${encodeURIComponent(next)}`);
  }

  // Always the same response — never reveal whether an account exists.
  return json({ ok: true, sent });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
