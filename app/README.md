# Glean · 拾遗 — app

The deployable Astro 4 app, in hybrid mode on Cloudflare Pages, with
D1 + KV + R2 + Queues + Access + Turnstile.

> Looking for project-level docs (license, contributing, design system)?
> See the [repo root](../).

## At a glance

```
prototype/         original static HTML — read-only design reference
app/               this project — deployable
  src/
    layouts/       Site.astro (public chrome) + Admin.astro
    components/    ArticleCard, WeeklyCover, LangSpan, StatusPill, Turnstile, TagBadge
    pages/         routes (Astro file-system)
    pages/api/     POST endpoints + RSS
    db/            Drizzle schema + client
    lib/           cache, ratelimit, turnstile, auth, queries, adminForm, rss
    middleware.ts  injects locals, enforces /admin Access + allowlist gate
  workers/
    ingest-consumer/  Worker — Queue consumer, URL → R2 (Readability + Jina)
    llm-consumer/     Worker — Queue consumer, R2 → DeepSeek/OpenAI → D1
  migrations/      D1 migrations
  seed/initial.sql tag taxonomy only — no demo content
  public/styles.css copy of prototype/styles.css
```

## Requirements

- Node 20+
- pnpm 9+
- A Cloudflare account (free tier is enough)

## One-time setup

```sh
pnpm install
pnpm wrangler login

# Each wrangler.toml is gitignored; the committed template is wrangler.toml.example.
# Copy each template to its real filename before editing:
cp wrangler.toml.example wrangler.toml
cp workers/ingest-consumer/wrangler.toml.example workers/ingest-consumer/wrangler.toml
cp workers/llm-consumer/wrangler.toml.example workers/llm-consumer/wrangler.toml

# Create the bindings — paste each printed id into the corresponding
# REPLACE_WITH_* placeholder in your local wrangler.toml files.
pnpm wrangler d1 create glean
pnpm wrangler kv namespace create CACHE
pnpm wrangler r2 bucket create glean-raw
pnpm wrangler queues create glean-ingest
pnpm wrangler queues create glean-ingest-dlq
pnpm wrangler queues create glean-llm
pnpm wrangler queues create glean-llm-dlq

# Turnstile sitekey (public) goes into wrangler.toml [vars].
# Create a Turnstile widget in the Cloudflare dashboard and paste the sitekey.

# Pages secrets (admin gate + LLM + Turnstile + cookie signing).
pnpm wrangler pages secret put ADMIN_EMAILS         # comma-separated, REQUIRED
pnpm wrangler pages secret put DEEPSEEK_API_KEY     # or OPENAI_API_KEY
pnpm wrangler pages secret put TURNSTILE_SECRET
pnpm wrangler pages secret put COOKIE_SIGNING_KEY   # 32-byte random hex

# Worker secrets (same LLM keys; ADMIN_EMAILS is not needed in workers).
pnpm wrangler secret put DEEPSEEK_API_KEY -c workers/ingest-consumer/wrangler.toml
pnpm wrangler secret put DEEPSEEK_API_KEY -c workers/llm-consumer/wrangler.toml

# Schema + seed (tag taxonomy).
pnpm db:migrate:local
pnpm seed:local

# Local dev secrets.
cp .dev.vars.example .dev.vars
cp workers/ingest-consumer/.dev.vars.example workers/ingest-consumer/.dev.vars
# …then fill in your keys in both files.
```

## Develop

```sh
pnpm dev                  # Astro dev server (http://localhost:4321)
pnpm worker:dev           # ingest consumer worker (separate terminal)
pnpm llm:dev              # llm consumer worker (third terminal, optional)
```

The Astro dev server uses `platformProxy` so D1 / KV / R2 / Queues all run
against local Miniflare emulations. No cloud calls during dev.

To access `/admin` locally, send the header `x-glean-admin-dev: 1`. Only
works when `import.meta.env.DEV` is true.

## Deploy

Three deployable surfaces, all from `app/`. Run only the ones your change
touches.

```sh
# Pages (UI + SSR routes).
pnpm db:migrate:remote
pnpm seed:remote          # only on a fresh DB
pnpm build && pnpm wrangler pages deploy ./dist

# ingest-consumer worker (URL fetch → R2).
pnpm wrangler deploy -c workers/ingest-consumer/wrangler.toml

# llm-consumer worker (R2 → LLM → D1).
pnpm wrangler deploy -c workers/llm-consumer/wrangler.toml
```

`src/lib/ingest.ts` is imported by both workers — touch it, deploy both.

### Deploy gotchas

- **`pnpm deploy` ≠ the script.** pnpm 9+ intercepts `deploy` as a workspace
  builtin and errors before running `package.json`. Use `pnpm run deploy` to
  force the script, or call `wrangler` directly as above.
- **`pnpm exec wrangler …`, not bare `wrangler`.** wrangler is a devDep, not
  global.
- **`wrangler tail` flaky.** Its websocket endpoint can `ETIMEDOUT` on some
  networks. To verify a submission processed, query D1 directly:
  ```sh
  pnpm wrangler d1 execute glean --remote --command \
    "SELECT id, status, reject_reason, ai_title_zh FROM submissions WHERE id='<ULID>'"
  ```

## Cloudflare Access (admin gate)

The `/admin*` and `/api/admin*` routes are gated by **two** layers:

1. **Cloudflare Access** (you configure this in the Zero Trust dashboard).
2. **`ADMIN_EMAILS` allowlist** (enforced inside `middleware.ts` even if
   Access lets the request through).

To set up Access:

1. Zero Trust → Access → Applications → Add application
2. Type: Self-hosted, host: your deployed domain, path: `/admin*`
3. Add a second application for `/api/admin*` with the same policy.
4. Policy: allow the curator email list with one-time PIN.

The middleware reads `Cf-Access-Authenticated-User-Email` (legacy) or the
`Cf-Access-Jwt-Assertion` JWT payload, then checks the email against
`ADMIN_EMAILS`. **Never deploy without setting `ADMIN_EMAILS`** — the gate
will refuse all admin requests.

## Cache layout

| Route                 | Cache-Control                                          |
|-----------------------|--------------------------------------------------------|
| `/`                   | max-age=30, s-maxage=60, swr=120                       |
| `/daily/<date>` today | max-age=60                                             |
| `/daily/<date>` past  | s-maxage=86400, swr=86400                              |
| `/weekly`             | s-maxage=300, swr=600                                  |
| `/weekly/<n>`         | s-maxage=86400, swr=86400                              |
| `/a/<slug>`           | s-maxage=86400, swr=86400                              |
| `/tag/<slug>`         | s-maxage=600, swr=1800                                 |
| `/standards`          | s-maxage=86400, swr=86400                              |
| `/rss/*.xml`          | s-maxage=300, swr=600                                  |
| `/admin/*`            | no-store                                               |
| `/submit*`            | no-store                                               |

Cache busting on publish/reject is handled by `bustForPick()` in
`src/lib/cache.ts`.

## Sanity check after dev server is up

```sh
for path in / /about /standards /design-system /weekly /daily /submit; do
  curl -sf "http://localhost:4321$path" -o /dev/null && echo "ok $path" || echo "FAIL $path"
done
```
