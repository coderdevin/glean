/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  RAW: R2Bucket;
  INGEST: Queue<string>;
  INGEST_LLM: Queue<string>;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  // LLM credentials — set at least one. If both are set,
  // LLM_PROVIDER decides; defaults to deepseek when only DEEPSEEK_API_KEY is set.
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  LLM_FALLBACK_MODEL?: string;
  COOKIE_SIGNING_KEY: string;
  SITE_NAME: string;
  SITE_URL: string;
  // IANA timezone name for editorial timestamps shown in the UI (e.g. the
  // publish time on /daily, the date on /a/<slug>). Default Asia/Shanghai.
  SITE_TZ?: string;
  CONTACT_EMAIL?: string;
  CORRECTIONS_EMAIL?: string;
  // Transactional email (Resend). RESEND_API_KEY is a secret; EMAIL_FROM is a
  // public var like "Glean 拾遗 <weekly@your-domain>". When RESEND_API_KEY is
  // unset, lib/email.ts logs to console instead of sending (local dev).
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  // Comma-separated allowlist of admin emails. Even when Cloudflare Access
  // fronts /admin*, the app enforces this list as a second gate. Unset = no
  // admin access in production (devBypass still works in local dev).
  ADMIN_EMAILS?: string;
}

declare namespace App {
  interface Locals extends Runtime {
    lang: "zh" | "en";
    adminEmail: string | null;
  }
}
