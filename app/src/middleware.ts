import { defineMiddleware } from "astro:middleware";
import { EN_PREFIX, splitLangPath } from "~/lib/i18n";

const LANG_COOKIE = "glean_lang";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);

  // Canonicalize trailing slashes → 301 to the no-slash URL. trailingSlash is
  // "ignore", so /about/, /tag/foo/, /en/x/ now MATCH a route and reach here;
  // we bounce them to the canonical form the whole site links to. (Static
  // _redirects can't do this — Cloudflare ignores it when a _worker.js exists.)
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    const stripped = url.pathname.replace(/\/+$/, "") || "/";
    return Response.redirect(new URL(stripped + url.search, url), 301);
  }

  const isAdmin =
    url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/admin");
  const isApi = url.pathname.startsWith("/api/");

  // Language is URL-driven: `/en/*` is English, everything else Chinese. This
  // is deterministic for crawlers (no cookie/Accept-Language guessing), which
  // is what makes the two language trees independently indexable. The cookie
  // only remembers a human's choice so the lang toggle can deep-link; it never
  // changes what a given URL renders.
  const { lang, basePath } = isApi
    ? { lang: "zh" as const, basePath: url.pathname }
    : splitLangPath(url.pathname);
  ctx.locals.lang = lang;
  ctx.locals.basePath = basePath;
  ctx.locals.adminEmail = null;

  // English URLs share the Chinese route templates: strip the `/en` prefix and
  // re-route internally. Middleware does not re-run on rewrite, so the locals
  // set above (lang = "en") carry through to the page.
  if (lang === "en" && url.pathname.startsWith(EN_PREFIX)) {
    return next(new URL(basePath + url.search, url));
  }

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

  // Remember the language of the page actually served so the nav lang toggle
  // (and any future "send returning visitors to their language" logic) has a
  // signal. Routing never reads this — the URL is authoritative.
  if (!isApi && !isAdmin) {
    ctx.cookies.set(LANG_COOKIE, lang, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }

  return res;
});
