# Contributing to Glean

Thanks for taking the time to look at Glean. This project is small and
opinionated; PRs that improve the **runtime** (Astro app, Workers, the
extract/LLM pipeline) are very welcome. PRs that change the **editorial
voice** (taglines, /standards copy, the LLM prompts) are best discussed in
an issue first.

## Getting set up

You'll need:

- Node 20+
- pnpm 9+
- A Cloudflare account (free tier is enough for development)

```sh
git clone <your-fork>
cd Glean
pnpm install                     # repo-level: installs husky pre-commit hook
cd app
pnpm install                     # app-level: installs Astro + Workers deps
cp .dev.vars.example .dev.vars   # fill in your DeepSeek or OpenAI key
pnpm wrangler login
```

Then follow the **One-time setup** section of `app/README.md` to create the
D1 / KV / R2 bindings under your own Cloudflare account.

### Secret scanning (gitleaks)

Every commit is scanned for accidentally staged API keys, tokens, and other
secrets. There are two layers:

1. **Local pre-commit hook** (`.husky/pre-commit`) — runs `gitleaks protect
   --staged` before each commit. Install gitleaks once so the hook can run:
   ```sh
   brew install gitleaks            # macOS
   # Linux: see https://github.com/gitleaks/gitleaks#installing
   ```
   If gitleaks isn't installed the hook prints a hint and lets the commit
   through — it's the CI check that's authoritative.

2. **GitHub Actions** (`.github/workflows/secret-scan.yml`) — runs gitleaks
   on every push and pull request. PRs with detected leaks cannot merge.

If you hit a false positive (e.g. a fixture or example key), either:
- Add an inline `# gitleaks:allow` comment on that line, or
- Add a rule to a repo-root `.gitleaks.toml` ([config docs][gitleaks-cfg]).

[gitleaks-cfg]: https://github.com/gitleaks/gitleaks#configuration

Legitimate bypass (rare, document the reason in the commit message):

```sh
git commit --no-verify -m "..."
```

## Running locally

```sh
pnpm dev                  # Astro at http://localhost:4321
pnpm worker:dev           # ingest worker (separate terminal)
pnpm llm:dev              # llm worker (third terminal, optional)
```

All bindings (D1 / KV / R2 / Queues) run through Miniflare. No cloud calls.

To access `/admin` locally, send the header `x-glean-admin-dev: 1` — only
works when `import.meta.env.DEV` is true.

## Pull request flow

1. Open an issue first if the change is non-trivial. "Non-trivial" =
   anything that touches the LLM prompt, the editorial standards page, the
   extract pipeline, or the auth/middleware layer.
2. Fork → branch → PR against `main`.
3. Keep PRs surgical. One topic per PR.
4. Run `pnpm typecheck` before pushing.
5. If you change anything in `src/lib/llm.ts`, include a sample
   before/after JSON output in the PR description so reviewers can sanity
   check.

## What I'll usually push back on

- Adding new fields to the LLM analysis schema without a clear editorial
  reason. Each field is a bilingual translation cost.
- Pulling in heavy UI libraries. Glean is hand-rolled CSS on purpose.
- "Improvements" to the design system without first reading
  `prototype/DESIGN.md`.
- Backwards-compat shims for removed code. Just delete it.

## Reporting security issues

See [SECURITY.md](./SECURITY.md). **Don't** open a public issue for security
problems.

## Code of conduct

By participating, you agree to the
[Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).
