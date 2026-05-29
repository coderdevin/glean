# Glean · 拾遗

> A bilingual technical zine. Hand-curated, human-reviewed. AI drafts; humans
> sign off.

Glean is an end-to-end implementation of an editorial publishing pipeline on
Cloudflare's edge stack:

- **Submit a link** → URL is fetched, body extracted, queued.
- **AI drafts** title / summary / bullets / tags / score (DeepSeek or any
  OpenAI-compatible provider) and writes them into a curator review queue.
- **An editor reviews** each card in `/admin/[id]`, edits inline, publishes.
- The published pick lands on `/`, `/daily/<date>`, `/weekly/<n>`, and in RSS.

## Why this exists

Most "AI newsletter" projects let the model do the picking. Glean inverts
that: the LLM is a fast-but-correctable summarizer, and a human signs off on
every pick before publish. The repo is a working reference for that
workflow — including the prompts, the schema, the queue topology, and the
admin UI.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Astro 4 (hybrid SSR) |
| Hosting | Cloudflare Pages |
| Background work | Cloudflare Workers + Queues (extract stage, LLM stage) |
| Storage | D1 (SQLite at edge) + R2 (raw bodies) + KV (cache + rate limit) |
| Auth (admin) | Cloudflare Access + email allowlist |
| Abuse control | Turnstile + sliding-window rate limit |
| LLM | DeepSeek (default) or any OpenAI-compatible endpoint |
| Article extraction | `@mozilla/readability` + linkedom + Jina Reader (fallback) + fxtwitter (for X) |

## Repo layout

```
app/         the deployable Astro + Workers app — start here
prototype/   original static HTML (design reference, read-only)
docs/        long-form design + planning docs
LICENSE      MIT
SECURITY.md  how to report vulnerabilities
CONTRIBUTING.md
CODE_OF_CONDUCT.md
```

## Getting started

See [`app/README.md`](./app/README.md). The short version:

```sh
cd app
pnpm install
pnpm wrangler login
# follow the One-time setup section to create D1/KV/R2/Queues bindings
cp .dev.vars.example .dev.vars
pnpm dev
```

## Before you deploy this anywhere public

This is important enough to call out:

1. **Set `ADMIN_EMAILS`** as a Pages secret (comma-separated list). The
   `/admin*` middleware refuses every request when this is empty, even with
   Cloudflare Access in front.
2. **Set up Cloudflare Access** in front of `/admin*` and `/api/admin*`.
   The email allowlist is a second gate, not a replacement.
3. **Set a strong `COOKIE_SIGNING_KEY`** (32 bytes random hex). The subscribe
   confirm flow signs tokens with it.
4. **Turnstile** must be configured (`TURNSTILE_SITEKEY` + `TURNSTILE_SECRET`)
   before the form goes public — the JSON API still works without it, but
   the browser-form path will reject everything.
5. **Don't commit `.dev.vars`** — it's gitignored. There is a `.dev.vars.example`
   you can copy.
6. **Rewrite the About page.** `app/src/pages/about.astro` ships with the
   default editorial copy for this instance. If you deploy your own Glean,
   replace the paragraphs there (and the GitHub link) with your own zine's
   story before going public.

## What's worth knowing about the prompts

The LLM analysis + sections prompts live in `app/src/lib/llm.ts`. They are
about ~300 lines combined and encode the editorial standards (bias scoring,
translation conventions, field-level quality rules). Forking the repo means
inheriting them as defaults — you'll almost certainly want to customize
them for your own zine's voice.

## License

MIT. See [LICENSE](./LICENSE).

## Acknowledgements

The visual design is a tribute to the warm-cream-and-coral editorial style
popularized by Anthropic's writing. Fonts: Source Serif 4 + JetBrains Mono +
LXGW Wenkai for CJK.
