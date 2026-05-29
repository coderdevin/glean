import { defineMiddleware } from "astro:middleware";

const LANG_COOKIE = "glean_lang";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const isAdmin =
    url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/admin");

  const cookieLang = ctx.cookies.get(LANG_COOKIE)?.value;
  const queryLang = url.searchParams.get("lang");
  const lang =
    queryLang === "en" || queryLang === "zh"
      ? queryLang
      : cookieLang === "en"
        ? "en"
        : "zh";
  ctx.locals.lang = lang;
  ctx.locals.adminEmail = null;

  // Header reads + Access gate only run for /admin* — those routes always run
  // on-demand (prerender = false), so request.headers is always available.
  if (isAdmin) {
    // Cloudflare Access exposes the authenticated user via two channels:
    //   1) `Cf-Access-Authenticated-User-Email` — legacy "Self-hosted" apps
    //   2) `Cf-Access-Jwt-Assertion` — signed JWT, used by the newer "Workers"
    //      / Pages app integration. Payload claim `email` is what we want.
    // Cloudflare guarantees nothing reaches our Worker without passing Access,
    // so we trust the JWT payload without verifying the signature here.
    let email = ctx.request.headers.get("cf-access-authenticated-user-email");
    if (!email) {
      const jwt = ctx.request.headers.get("cf-access-jwt-assertion");
      if (jwt) {
        try {
          const [, payloadB64] = jwt.split(".");
          if (payloadB64) {
            const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
            const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
            const payload = JSON.parse(atob(padded + pad));
            if (typeof payload.email === "string") email = payload.email;
          }
        } catch {
          // fall through; email stays null
        }
      }
    }
    ctx.locals.adminEmail = email;

    const devBypass =
      import.meta.env.DEV && ctx.request.headers.get("x-glean-admin-dev") === "1";
    if (!ctx.locals.adminEmail && !devBypass) {
      // No Access identity reached us. In production this means Access isn't
      // in front (misconfiguration) or the gate stripped the header. Refuse
      // without leaking which cf-* headers we did see — that's recon material.
      return new Response("401 — admin access required", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (devBypass && !ctx.locals.adminEmail) {
      ctx.locals.adminEmail = "dev@local";
    }

    // Second gate: even though Access guards the route, enforce an explicit
    // email allowlist here. This prevents the case where Access is mis-policied
    // to "anyone with an email" — Access alone is not authorization.
    // dev@local (from devBypass above) is allowed in DEV only.
    const allowRaw = ctx.locals.runtime?.env?.ADMIN_EMAILS ?? "";
    const allowList = allowRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const current = (ctx.locals.adminEmail ?? "").toLowerCase();
    const isDevLocal = import.meta.env.DEV && current === "dev@local";
    const isAllowed = isDevLocal || (allowList.length > 0 && allowList.includes(current));
    if (!isAllowed) {
      // Echo the rejected email and the (count of) configured allowlist —
      // safe because Access has already authenticated the user, so they're
      // seeing their own identity, not someone else's. Do NOT echo the
      // allowlist contents themselves.
      const body = [
        "403 — email not on admin allowlist",
        "",
        `Access reported your email as: ${current || "(empty)"}`,
        `Allowlist has ${allowList.length} email(s) configured.`,
        "",
        "Fix: add this exact email to the ADMIN_EMAILS Pages secret, or",
        "reconfigure your Access identity provider to surface the email you",
        "expect.",
      ].join("\n");
      return new Response(body, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  const res = await next();

  if (queryLang === "en" || queryLang === "zh") {
    ctx.cookies.set(LANG_COOKIE, queryLang, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }

  return res;
});
