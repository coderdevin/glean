# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in Glean, please **do not** open a
public GitHub issue. Instead, email the maintainer at:

**devin.yang@smartcoder.ai**

Please include:

- A clear description of the issue (and ideally a minimal reproduction).
- The affected file paths or routes.
- Whether you have any preference for credit / coordinated disclosure.

You can expect an acknowledgement within ~5 business days. For confirmed
issues, the fix and disclosure timeline will be coordinated with you before any
public discussion.

## Scope

Glean is a Cloudflare Pages + Workers app. In-scope concerns include, but are
not limited to:

- Bypasses of the `/admin*` gate (Cloudflare Access + `ADMIN_EMAILS` allowlist).
- SSRF in the URL extraction pipeline (`src/lib/extract*.ts`).
- Injection in the bilingual content rendering path (`src/components/`,
  `src/lib/rss.ts`).
- Cookie / token forgery (`src/lib/auth.ts`, the subscribe confirm flow).
- Rate-limit bypass on `/api/submit` and `/api/subscribe`.

Out of scope:

- Issues that require Cloudflare-account-level compromise.
- Reports against third-party services Glean integrates with (DeepSeek,
  OpenAI, Jina Reader, fxtwitter).
- Spam / abuse that the rate limiter is *intended* to throttle but doesn't
  fully prevent — Glean's editorial-review step is the abuse floor.

## Deployment hardening checklist

Forks running their own instance should at minimum:

1. Put Cloudflare Access in front of `/admin*` **and** `/api/admin*`.
2. Set the `ADMIN_EMAILS` secret with a comma-separated allowlist.
3. Set `TURNSTILE_SECRET` + matching public `TURNSTILE_SITEKEY`.
4. Set `COOKIE_SIGNING_KEY` to a 32-byte random hex.
5. Never deploy without the above. The middleware will refuse `/admin*` if
   the allowlist is empty, but other defenses depend on you setting them.
