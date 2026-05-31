# Live site audit — glean.smartcoder.ai (2026-05-31)

Method: HTTP sweep + agent-browser (desktop 1366 + mobile 390), zh + en, every page type.
Severity: 🔴 critical · 🟠 high · 🟡 medium · 🔵 low/polish.
Status: ✅ fixed+deployed · 📝 recorded (needs your decision).

Pages tested: `/`, `/a/<slug>`, `/daily/<date>`, `/weekly` + `/weekly/<n>`, `/tag` + `/tag/<slug>`,
`/about`, `/standards`, `/submit`, plus zh/en variants and trailing-slash variants.
Most pages render correctly; the issues below are the exceptions.

---

## ✅ Fixed & deployed to production

### F1 🟠 Trailing-slash URLs 404 / 500 site-wide
- Before: `/about/`, `/standards/`, `/submit/`, `/tag/`, `/weekly/`, `/daily/` → **404**; `/en/<x>/` → **500**.
- Root cause: `trailingSlash:"never"` made trailing-slash paths unmatched → 404 *before* middleware. And Cloudflare **ignores `_redirects` whenever a `_worker.js` exists** (Astro's adapter emits one), so a static redirect file can't help.
- Fix: `trailingSlash:"ignore"` (paths now match a route → middleware runs) + a middleware **301** to the no-slash URL + added `/about/`,`/standards/` to the worker route includes.
- Verified live: every trailing-slash variant now `301 → no-slash → 200`, no loops, `/en/<x>/` 500 gone.

### F2 🟠 Language toggle (中/EN) broken & ugly
- Before: jammed unstyled "中EN" (user screenshot). Root cause: P1 changed the toggle from `<button>` to `<a>`; all `.lang-toggle button` CSS stopped matching.
- Fix: rewrote `.lang-toggle` as a clean **segmented pill** targeting `a` — active language = raised chip, inactive = muted; updated focus-visible + font selectors too.
- Verified live: renders as "中 | EN" pill; computed `border-radius:999px` + raised active chip.

### F3 🟡 "提交链接" core CTA looked like plain text
- Before: `.nav-link--cta` was muted gray text — no button affordance, despite being the core action.
- Fix: restyled as a **coral outline pill** that fills on hover (top-nav, both languages).
- Verified live: coral border+text, `border-radius:999px`.
- NOTE: design direction — please confirm you like the pill treatment (F2 + F3 are subjective).

---

## 📝 Recorded — need your decision (low severity, not auto-fixed)

### F4 🔵 English home: terminal-demo `note` string stays Chinese
- On `/en`, the hero terminal mock shows `"note":"DO 终于支持跨地域副本"` (Chinese) inside an otherwise-English page. It's a hardcoded playful demo string in `index.astro`.
- Options: (a) translate it for /en, (b) leave as-is (it's a fake curl demo), (c) make it lang-aware. Low impact.

### F5 🔵 Tag index shows zero-count tags as clickable
- `/tag` lists tags with `· 0` (e.g. Cloudflare, Edge, Workers, SQLite, Linux, TypeScript). Clicking one leads to an empty tag page. (They're already excluded from the sitemap.)
- Options: (a) hide zero-count tags, (b) show them non-clickable/dimmed, (c) leave. Minor UX.

---

## Notes
- Internal navigation never uses trailing slashes, and the sitemap is all no-slash, so F1's SEO impact was limited — but the 500 and dead-page UX warranted the fix.
- All other pages (article reader, daily, weekly, tag detail, about, standards, submit form, success) render correctly in both languages on desktop and mobile; no console errors observed on `/`.
