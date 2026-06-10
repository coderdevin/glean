# AGENTS.md

Conventions for AI coding assistants (Claude Code, Cursor, Copilot, etc.)
working in this repo. Most of this is "how to not make a mess"; the
**Glean-specific** sections at the bottom are the parts you should read every
time before deploying.

## 0. Language

The user works in Chinese. Reply and explain in Chinese unless the user writes
to you in English or asks otherwise. Code, identifiers, and commit/PR text stay
in their conventional language.

## 1. Think before coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- **Re-read the source of truth before implementing.** Re-open the authoritative
  artifact and follow it exactly — don't reconstruct it from memory or an earlier
  draft. Design → the matching `prototype/*.html` (match its layout and width).
  Copy → the current file content, not a version you remember (the user may have
  revised it; ask which is current). Data field → the exact column requested
  (`created_at` ≠ `updated_at`). Bilingual scope → if the user mentions zh and en,
  build both; default to both for reader-facing text.
- **Never override a documented constitution/spec on your own initiative.** You
  may argue it's wrong — then ask first, don't just deviate.

## 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.

Glean instances of this rule being ignored:

- Apply a feature only where asked — the bilingual 对照 toggle belongs on the
  article page, not all 12 pages.
- Prefer the simplest mechanism: a `curl` against an existing API over a new
  CLI; no new tokens or dependencies unless the user asked for them.
- **Never constrain an LLM-extracted field (tags, category) to a hardcoded enum
  or whitelist.** Let the model extract freely from content. Check UI coupling
  first, but the default is LLM freedom, not a fixed taxonomy.

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

## 5. Verify before reporting done

Never say a change works until you have exercised it yourself. A page that
compiled is not a page that loads. Match the check to the surface:

- **UI / page change** → load it (local `pnpm dev`, or the deployed URL via
  agent-browser) at **both** `/path` and `/en/path`, and confirm a 200 plus the
  expected pixels. The trailing-slash/SSR trap returns 404/500 even when the
  build is green.
- **Admin change** → confirm `/admin` still authenticates (Cloudflare Access
  **and** the `ADMIN_EMAILS` gate); a secret rotation or middleware edit
  silently 403s every admin.
- **Pipeline / LLM change** → push a real submission through and query D1 for the
  terminal `status` + `reject_reason`; a billed API call is not a successful parse.
- **Model / provider change** → confirm the exact model id is accepted before
  deploying (use the real ids, not an invented `deepseek-ai/...` string).

If you cannot verify, say so explicitly rather than implying success.

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

## Glean: UI work — design pass, don't ship the first draft

Functional ≠ done for any reader-facing or admin UI. Before reporting:

- **Screenshot it yourself** at 1280px and 375px (agent-browser) and actually
  look at it. Recurring defects to kill: dead right-side whitespace / under-used
  horizontal space, content columns too narrow, section/heading fonts too small,
  native browser dialogs left unstyled, non-clickable cards (make the whole card
  a link, not just the title).
- **Match `prototype/*.html`** widths and structure when a reference exists —
  diff it, don't approximate.
- For non-trivial visual work, run the `impeccable` / `frontend-design` skill
  rather than hand-rolling layout.
- The design-system "single Serif Latin" constitution is binding. Don't change
  typography on your own initiative — you may propose challenging it, but ask first.

## Glean: browser testing — use the user's existing browser

When testing or authenticating against the deployed site, drive the user's
already-running browser (agent-browser native/attach mode) — they are already
logged in (Cloudflare Access, admin). Don't spawn a fresh browser with no
session unless the user asks.
