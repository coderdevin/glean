# AGENTS.md

Conventions for AI coding assistants (Claude Code, Cursor, Copilot, etc.)
working in this repo. Most of this is "how to not make a mess"; the
**Glean-specific** sections at the bottom are the parts you should read every
time before deploying.

## 1. Think before coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.

## 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

## 4. Goal-driven execution

Transform vague tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

---

## Glean: deploy paths

Three deployable surfaces, all from `app/`. Run only the ones your change
touches.

```bash
cd app

# Pages (UI + SSR routes): anything under src/pages, src/components,
# src/layouts, plus src/lib/queries.ts, src/lib/ratelimit.ts, etc.
pnpm build && pnpm exec wrangler pages deploy ./dist

# ingest-consumer worker (URL fetch → R2):
#   src/lib/extract*.ts, src/lib/ingest.ts (processExtract).
pnpm exec wrangler deploy -c workers/ingest-consumer/wrangler.toml

# llm-consumer worker (R2 → LLM → D1):
#   src/lib/llm.ts, prompt code, src/lib/ingest.ts (processLlm).
pnpm exec wrangler deploy -c workers/llm-consumer/wrangler.toml
```

`src/lib/ingest.ts` is imported by both workers — touch it, deploy both.

## Glean: deploy gotchas

- **`pnpm deploy` ≠ the script.** pnpm 9+ intercepts `deploy` as a workspace
  builtin and errors before running `package.json`. Use `pnpm run deploy` to
  force the script, or call `wrangler` directly. Same applies to any script
  name that collides with a pnpm builtin.
- **`pnpm exec wrangler …`, not bare `wrangler`.** wrangler is a devDep,
  not global.
- **`wrangler tail` flaky.** Its websocket endpoint can `ETIMEDOUT` on some
  networks. To verify a submission processed, query D1 directly:
  ```bash
  pnpm exec wrangler d1 execute glean --remote --command \
    "SELECT id, status, reject_reason, ai_title_zh FROM submissions WHERE id='<ULID>'"
  ```
  Or open `/admin`.

## Glean: things to never do without asking

- Change anything in `src/lib/llm.ts` prompts — that's the editorial voice
  of the publication, not a code concern.
- Change the analysis JSON schema — every field flows through the admin UI,
  RSS, and prerendered pages.
- Touch the auth middleware (`src/middleware.ts`) without re-reading
  [SECURITY.md](./SECURITY.md). The `ADMIN_EMAILS` gate is load-bearing.
