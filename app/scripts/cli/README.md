# Glean CLI

A terminal-native, scriptable, **dual-use** (human-readable by default, `--json` for
machine/agent consumption) surface over the public Glean API. It is the **normal-user**
tool: submit links and query the wiki + published picks. Admin operations (rebuilding the
wiki, lint) live in the authenticated `/admin` web UI, not here.

It talks to Glean **purely over HTTP** — no D1, no wrangler, no Cloudflare Access. It only
touches data that is already public (homepage / daily / tag / wiki / RSS).

## Run

```sh
pnpm cli <command> [args]          # from app/
# or, once linked:  npm link  →  glean <command> [args]
```

## Commands

```
glean submit <url> [--note <text>] [--as <name>] [--watch] [--json]
glean status <id> [--watch] [--json]
glean query [terms…] [--tag <slug>] [--category <slug>] [--date YYYY-MM-DD] [--limit <n>] [--offset <n>] [--lang zh|en] [--json]
glean read  <slug> [--lang zh|en|both] [--json]
```

- **submit** — POSTs to `/api/submit` (JSON submissions skip the CAPTCHA; the 10/IP/hour rate
  limit still applies). Reports the new submission id, an existing id if the URL is already in
  flight, or the canonical link if it's already published. `--watch` follows the pipeline.
- **status** — polls `/api/submit/status`. `--watch` polls until the AI pipeline rests
  (`ready`/`published`/`rejected`/`failed`), tolerating transient errors; exits nonzero on
  `rejected`/`failed`.
- **query** — searches **both** the wiki map (curated themes) and the published picks. Bare
  `glean query` prints the wiki map + recent picks; with terms, matching wiki topics print
  above matching picks. Pick filters (`--tag`/`--category`/`--date`/`--offset`) narrow the
  picks (and skip the wiki).
- **read** — prints a pick's full bilingual body (sections, summary, tags).

## Config

| Env | `~/.glean/config.json` | Default |
|-----|------------------------|---------|
| `GLEAN_BASE_URL` | `baseUrl` | `https://glean.smartcoder.ai` |

Point at a local dev server with `GLEAN_BASE_URL=http://localhost:4321` (or whatever port
`pnpm dev` printed).

## Exit codes

`0` ok · `1` usage/generic · `3` rate limited · `4` not found · `5` submission rejected/failed.

## Tests

```sh
pnpm exec tsx scripts/cli/cli.test.ts     # pure logic
pnpm exec tsc -p scripts/cli/tsconfig.json  # types  (or: pnpm typecheck:cli)
```

## Server side

The CLI is backed by public, read-only JSON endpoints (thin wrappers over `src/lib/queries.ts`):
`GET /api/picks`, `GET /api/picks/[slug]`, `GET /api/wiki`. They expose nothing not already
public and are CDN-cached with a short `s-maxage` (no KV layer to invalidate). The wiki itself
is built/maintained by admin via `/admin/wiki` (the LLM-Wiki **ingest** + **lint** verbs).
