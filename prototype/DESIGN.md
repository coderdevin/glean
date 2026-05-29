# Glean · 拾遗 · Design System

> A bilingual technical zine. A small editorial team picks up 2–3 links worth reading every day; bundles them into a Monday weekly. This document records every non-obvious design decision, so the next person reading it (or the next agent editing it) can hold the same opinions for the same reasons.

---

## 1 · The Brand

### What Glean is, in three words

**Editorial · Hand-curated · Anti–tech-bro.**

Not "modern," not "elegant," not "minimal." Those are dead categories. Glean is meant to feel like **a Sunday-morning newspaper supplement** that someone has already underlined for you in coral pen — printed on cream stock, set in real serif type, with weekly volumes you can shelve.

Anti-references: SaaS landing pages, Medium, every "tech newsletter" with purple-blue gradients and rounded-corner glass cards.

### Who reads it, when, where

Engineers and engineering-adjacent thinkers who already use NetNewsWire / Reeder / RSS — people whose information diet is voluntary and curated, not algorithmically fed. They read at desk, on phone during commute, sometimes in bed at night. Both Latin and CJK script readers (the bilingual story is the product, not a localization layer).

### The single design decision everything else descends from

**Glean does not host content; Glean curates.** Every page is in service of sending the reader to the *source* — clearly, with enough editorial framing to justify the 12 minutes the original asks for. The site itself is reading furniture, not the destination.

This is why:
- No infinite scroll, no algorithmic feed
- No tracking, no "engagement metrics"
- The article-detail page is meant to be **leaved from**, not lingered on
- Every list, archive, and tag page leads back to a specific outbound link

---

## 2 · Typography

### The system

Two families. Serif carries hierarchy *and* body. Mono carries code and the "system label" tier. No general-purpose sans-serif.

```
Display + body   Newsreader       (variable, optical-sized, roman + italic, weights 400/500/600)
Display + body   LXGW WenKai      (CJK kaiti, weights 300/400/500)
Mono             JetBrains Mono   (weights 400/500)
```

### Why these, not the obvious ones

The reflex picks for a "warm editorial bilingual technical zine" would be:
- Cormorant Garamond + Inter + IBM Plex Mono — **all three banned** (they are training-data defaults; they create monoculture across every AI-designed site).

We rejected those and went further:

- **Newsreader** — Production Type's free, variable, optical-size serif built for *editorial / news* reading on screen, with a genuine italic. Warmer and more characterful at display sizes than a neutral book serif, while staying a calm workhorse for long body text. Its `opsz` axis adds stroke contrast as the headline grows, so weight 400 already reads as an editorial display cut — and its true italic carries the *Glean* wordmark (no faux slant). Pairs with CJK kaiti without fighting it. (Earlier instances shipped with Source Serif 4; swapped to Newsreader for more editorial personality on the Latin side.)
- **LXGW WenKai** (霞鹜文楷) — Vince Chen's free screen-tuned 楷体 (kaiti). The choice of **kaiti instead of 宋体 (songti)** is the single most distinctive Chinese-typography decision: songti reads as "tech print product" (every Chinese tech publication uses it); kaiti reads as "handwritten" / "literary." It matches the editorial-zine voice, and it visually whispers *拾遗 (glean)* — "manually picked up by hand."
- **JetBrains Mono** — kept for code and for the "system label" tier (eyebrow, badge, breadcrumb, meta-key). Not banned and well-fit. The one place where sans-style geometry lives.

If you ever want to revisit the font picks: do the [`font_selection_procedure`](https://github.com/anthropic-experimental/impeccable) — three brand words, then reject your reflex picks, then look further.

### Why serif body, not sans body

Two reasons:

1. **The site is for long-form reading, not a UI.** Sans-serif body is for transactional UI (admin, dashboards, settings). The Glean reader has come to read, not to click — serif body makes the page feel like a publication, not a product.
2. **CJK + serif is a natural pair.** Pairing kaiti (CJK) with sans-serif Latin creates a script clash; pairing kaiti with Newsreader keeps the eye on one rhythm.

The exception is `JetBrains Mono` for code/labels — the only "sans-style" geometry on the site.

### Type scale

rem-based, ~1.25 modular ratio, 9 sizes:

| Token | Size | Use |
|---|---|---|
| `--text-xs`   | 0.75rem  / 12px | eyebrow, caps-up label |
| `--text-sm`   | 0.875rem / 14px | secondary body, captions, code |
| `--text-base` | 1rem     / 16px | default body, small titles |
| `--text-md`   | 1.125rem / 18px | subheading, generous body |
| `--text-lg`   | 1.375rem / 22px | card / pick titles |
| `--text-xl`   | 1.75rem  / 28px | display-sm, section openers |
| `--text-2xl`  | 2.25rem  / 36px | display-md, page banners |
| `--text-3xl`  | 3rem     / 48px | display-lg, issue mastheads |
| `--text-4xl`  | clamp(2.5rem, 6vw, 4rem) | hero only (40→64px fluid) |

**Body is always ≥ 16px** (WCAG a11y floor, mobile).

### Line height

Tuned for bilingual CJK + Latin. CJK reads tighter than Western default 1.6.

| Token | Value | Use |
|---|---|---|
| `--leading-display` | 1.10 | display sizes (28px+) |
| `--leading-title`   | 1.20 | section headers |
| `--leading-snug`    | 1.25 | titles in cards |
| `--leading-normal`  | 1.50 | body (CJK-tighter than 1.55) |
| `--leading-dense`   | 1.45 | dense body — card meta |
| `--leading-loose`   | 1.55 | lead paragraphs |

### Letter-spacing

em-based, scales with size:

| Token | Value | Use |
|---|---|---|
| `--tracking-display` | -0.025em | display |
| `--tracking-title`   | -0.01em  | titles |
| `--tracking-normal`  | 0        | body |
| `--tracking-caps`    | 0.1em    | uppercase labels |

### Weights

Per the design-system spec: **serif 正文 400 · 标题 500 · label 600**.

- **400** — body prose (serif)
- **500** — titles, displays (serif)
- **600** — labels / eyebrows (mono, uppercase, 0.1em tracking)

`<strong>` is **500**, not 600 — the rule "weight 500 = title weight" means emphasis should not visually outrank a heading.

### OpenType features

Body and code use deliberate feature settings:

- **Body**: `kern 1, liga 1, calt 1` (kerning + standard ligatures + contextual alternates)
- **Code (`.t-code`)**: `kern 1, liga 0, calt 1, zero 1` (NO programming ligatures, slashed zero)
- **Tables / data**: `font-variant-numeric: tabular-nums` (queue table, feed-row time, calendar)

### CJK hygiene

- `word-break: keep-all` on display sizes — prevents Chinese compounds (周一, 闭环, etc.) from breaking mid-word
- `text-wrap: balance` on titles — better line distribution
- `line-break: strict` — strict CJK line-break rules
- `overflow-wrap: anywhere` on body text — long URLs still wrap

---

## 3 · Color

### Theme decision

**Light is the default.** Glean is read at coffee, at lunch, on Monday mornings — light contexts. A wedding-planning checklist or a food magazine homepage; not an SRE dashboard.

But **dark mode ships** via `prefers-color-scheme: dark` (and a manual `[data-theme="dark"]` override). Some readers are in night mode by OS preference; we respect it.

### Two-layer token architecture

The system has **primitive** tokens (raw OKLCH scales, theme-independent) and **semantic** tokens (`--c-*`, what components consume). Dark mode is implemented by overriding semantic tokens; primitives stay put.

```
PRIMITIVE LAYER          (OKLCH, ~12 scales)
  --coral-300/500/600    brand
  --warm-50–400          cream surfaces
  --ink-300–950          dark scale (warm-tinted neutrals)
  --teal/amber/green/red/yellow-500   accents
  
   ↓ semantic mapping

SEMANTIC LAYER           (what components use — public API)
  --c-primary, --c-canvas, --c-surface-card, --c-ink, --c-body, ...
  
   ↓ component CSS reads only from this layer

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    // re-map semantic tokens to different primitives
    --c-canvas: var(--ink-900);   // was --warm-50
    --c-ink:    var(--warm-50);   // was --ink-950
    ...
  }
}
```

This means components don't know the theme exists — they consume `var(--c-canvas)` and the page just is dark or light.

### Why OKLCH, not HSL

OKLCH is perceptually uniform: equal steps in lightness *look* equal, which HSL doesn't deliver. Generating accessible tints (e.g. coral at 15% alpha for a badge background) is one-line:

```css
--coral-tint: oklch(63% 0.105 32 / 15%);
```

Try that in HSL and the badge will visually feel like a different color on different brand hues. OKLCH keeps tone consistent.

### Brand palette

| Role | Token | OKLCH | Note |
|---|---|---|---|
| Primary brand | `--c-primary` → `coral-500` | `oklch(63% 0.105 32)` | Coral. Editorial pen-mark color. |
| Active state | `--c-primary-active` → `coral-600` | `oklch(51% 0.105 32)` | Darker pressed state. |
| Canvas | `--c-canvas` → `warm-50` | `oklch(98% 0.005 75)` | Cream. Never pure white. |
| Body text | `--c-body` → `ink-700` | `oklch(31% 0.003 60)` | Dark warm. Never pure black. |
| Hairline | `--c-hairline` → `warm-200` | `oklch(92% 0.013 75)` | Subtle dividers. |

**All neutrals carry a 65° hue tint** (coral-warmth) at chroma ~0.005–0.018. This is the "subliminal cohesion" rule — pure gray would look sterile against coral; the warm tint makes everything feel of-the-same-family.

### Accent palette (10% by visual weight)

| Family | Use |
|---|---|
| Teal (`--c-accent-teal`)   | Infra category tags, "fresh" status |
| Amber (`--c-accent-amber`) | Data category tags, issue eyebrow on dark cards |
| Green (`--c-success`)      | Published status, low-impact |
| Yellow (`--c-warning`)     | Warning state |
| Red (`--c-error`)          | Rejected status, error state |

The dark-on-tint readable versions (`--c-text-teal-dark`, `--c-text-amber-dark`, `--c-text-coral-dark`, `--c-text-green-dark`) are auto-inverted in dark mode so badges and impact callouts stay AA-readable on both flips.

### Tag category color-coding

Three families only (not rainbow):

| Class | Family | Examples |
|---|---|---|
| `.badge--cat-infra` | teal | Edge, Cloudflare, Infra |
| `.badge--cat-data`  | amber | Database, DB, Storage |
| `.badge--cat-code`  | coral | React, Framework, JS, TS, Performance, Linux |

This lets the eye scan a daily strip and recognize *what kind of pick* before reading the title.

### Dark mode flips, in plain English

When the OS prefers dark:

1. **Page becomes the editorial dark surface.** The previously-cream canvas is now the dark color that used to be reserved for issue covers.
2. **Dark cards flip to cream.** The .card--dark, .issue-cover, .article-card--featured, .footer were "high-contrast accent dark blocks" on a cream page. Now they become "warm cream islands" on a dark page — the contrast pattern *flips* but the editorial role stays.
3. **Amber eyebrow re-binds.** Light-amber on cream = invisible. So inside the cream-card family, `--c-accent-amber` rebinds to `oklch(48% 0.110 65)` (darker amber). Achieved via component-scoped CSS variable override; no component CSS changes.

### Accessibility (color)

- Body on canvas: ~14:1 (AAA)
- Muted on canvas: 4.86:1 (AA)
- Muted-soft on canvas: 4.51:1 (AA, was 3.32:1 — bumped during audit)
- Primary button bg vs text: ~3.3:1 (AA-large only — known design trade-off for brand)
- All text in tints (`--c-text-*-dark`): ≥4.5:1 in both light and dark

### Anti-patterns

- ❌ Pure `#000` or `#fff` (always tinted)
- ❌ rgba() hardcodes (use color-mix tokens or scrim helpers)
- ❌ Hex outside :root primitive layer (use semantic tokens)
- ❌ AI palette: cyan-on-dark, purple-blue gradient, neon accents
- ❌ Gray text on coral / colored backgrounds (use a darker shade of the same hue)

---

## 4 · Space

### Scale

4pt base, semantic names:

| Token | px | Use |
|---|---|---|
| `--s-xxs` | 4  | tight inline gaps |
| `--s-xs`  | 8  | adjacent siblings |
| `--s-sm`  | 12 | tag clusters, button row gap |
| `--s-md`  | 16 | default card padding axis |
| `--s-lg`  | 24 | content blocks, card padding |
| `--s-xl`  | 32 | card padding (large), section gaps |
| `--s-xxl` | 48 | section padding (tight) |
| `--s-section` | 96 | section padding (open) |

### Use `gap`, not margins

`gap` for siblings — eliminates margin collapse and the cleanup hacks.

### Rhythm, not monotone

Sections vary padding intentionally:

| Class | Padding |
|---|---|
| `.section`           | 96 / 96  (hero, big editorial moments) |
| `.section--tight`    | 48 / 48  (default content sections) |
| `.section--showcase` | 96-120 / 48  (asymmetric; opens up at top, settles at bottom — used between two tight sections to create a beat) |

### Container widths

- `--container-max: 1200px` — page max width
- Long-read content within: capped at 65-75ch via per-element max-width

### Anti-patterns

- ❌ Arbitrary px values outside the scale (no `padding: 13px`)
- ❌ Equal spacing everywhere (rhythm requires variation)
- ❌ Centered everything (left-aligned + asymmetric reads as designed)
- ❌ Body text beyond ~80 ch line length

---

## 5 · Responsive

### Breakpoint system (canonical)

For new page-level work:

| Token | Value | Context |
|---|---|---|
| `--bp-sm` | 640px  | small phone landscape / large phone portrait |
| `--bp-md` | 768px  | tablet portrait |
| `--bp-lg` | 1024px | tablet landscape / small desktop |
| `--bp-xl` | 1280px | desktop |

(CSS custom properties don't work inside `@media` queries — these are documentation intent only. The actual media queries use the literal pixel values.)

### Container queries for components

Where a component might appear in containers of varying widths (e.g., `.footer__grid` inside a regular page vs. embedded in a preview tool), we use `@container`:

```css
.footer {
  container-type: inline-size;
  container-name: footer;
}
@container footer (max-width: 900px) {
  .footer__grid { grid-template-columns: 1fr 1fr; }
}
```

### Touch targets

WCAG 2.5.5 AAA: ≥ 44 × 44 px. Enforced on:

- `.btn { min-height: 44px }`
- `.btn-icon { 44 × 44 }`
- `.nav-toggle { 44 × 44 }` (hamburger)
- `.lang-toggle button { min-width: 44px }`

`.cal-widget__day` at 26 × 26 is the one exception — WCAG 2.5.8 AA permits ≤24×24 with adequate spacing offset, and 26 + 4 gap satisfies that.

### Mobile-specific adaptations

| Component | < breakpoint | Behavior |
|---|---|---|
| `.nav-links` | < 880px | hamburger drawer (translate from right) |
| `.daily-strip` | < 900px | 2-col → 1-col stack; lead card releases row-span |
| `.queue-table` | < 1000px | wrapped in `.queue-scroll`; horizontal scroll + right-edge fade mask |
| `.article-detail__meta` | < 640px | flex row → 2-col grid (key | value); separator dots hidden |
| `.feed-row` | < 720px | aside column hidden, title size shrinks |
| `.issue-list-card` | < 760px | 2-col → 1-col stack |

---

## 6 · Components Inventory

### Buttons

`.btn` (base, 44px) + variants:
- `.btn-primary` — coral fill, white text. Primary action.
- `.btn-secondary` — canvas fill, hairline border, ink text. Default action.
- `.btn-text` — no fill, no border, primary color hover. Tertiary link-style.
- `.btn-icon` — 44×44 circular, hairline border.
- `.btn-on-dark` — dark-elevated fill, for use on `--c-surface-dark` contexts.
- `.btn-cream-on-coral` — canvas fill, ink text, for use on coral CTA bands.

### Cards

`.card` (base) + variants:
- `.card--canvas` — canvas fill + hairline border. Default editorial card.
- `.card--cream-strong` — strong cream fill. Featured.
- `.card--dark` — dark fill, on-dark text. High-contrast accent.
- `.card--coral` — coral fill, on-primary text. Promotional.

`.article-card` — specialized card for daily / weekly picks. Has `__head`, `__title`, `__summary`, `__bullets`, `__editorial`, `__footer`, `__meta` slots. `--featured` modifier flips to dark surface.

### Tags / Badges

`.badge` (base) + variants:
- `.badge--coral` — uppercase, tracking, brand-emphasis label (头条)
- `.badge--teal / --amber / --on-dark` — semantic background tints
- `.badge--cat-infra / --cat-data / --cat-code` — category family color-coding (auto in dark mode)

### Status pills

`.status-pill` + state classes (admin):
- `.status-pending` — dashed transparent (queue waiting)
- `.status-processing` — amber tint
- `.status-ready` — teal tint
- `.status-published` — green tint
- `.status-rejected` — red tint

### Forms

- `.input` — 44px height, hairline border, focus ring (coral at 15% alpha)
- `.textarea` — min-height 120px, vertical resize
- `.field` — label + input + hint stack
- `.admin-field` — denser variant for admin panel

### Layout primitives

- `.container` — max-width 1200px, gutter padding
- `.section` / `.section--tight` / `.section--showcase` — vertical rhythm
- `.grid` / `.grid--cols-2` / `.grid--cols-3` / `.grid--hero` — common grids
- `.row` / `.row--between` — flex rows
- `.stack` / `.stack--lg` / `.stack--xl` — vertical stacks with rhythm

### Specialized

- `.issue-cover` — weekly cover dark surface, big ghost numeral
- `.issue-masthead` — top of weekly issue page
- `.daily-strip` — newspaper "lead + 2 supporting" layout
- `.feed-row` — daily timeline row
- `.pick-item` — weekly pick row (big numeral + content)
- `.decision-card` — article "worth your time" verdict
- `.editorial-callout` — pull-quote with `—` lead
- `.cat-toc` — sticky horizontal category nav inside weekly issue
- `.calendar-popover` — date picker in daily nav
- `.queue-table` + `.queue-scroll` — admin queue
- `.traffic-lights` — macOS-style window dots for CLI mockup

### Brand mark

The `<svg class="brand__mark">` — circle + curve glyph representing **a head bent over to pick up** (拾, "to glean"). Always inherits color from `currentColor`.

---

## 7 · Anti-Patterns (Banned)

These create the "AI-generated 2024-2025" fingerprint. Match-and-refuse:

| # | Pattern | Why banned | Use instead |
|---|---|---|---|
| 1 | `border-left:` or `border-right:` > 1px as accent stripe | Single most overused "design touch" in admin/dashboard UIs | Full borders, background tints, leading numbers, or no indicator |
| 2 | Gradient text (`background-clip: text` + gradient) | Decorative rather than meaningful | Solid color; emphasis via weight or size |
| 3 | Glassmorphism (decorative blur cards) | Dated trend | Solid surfaces; blur only when intentional (sticky nav) |
| 4 | Sparkline as decoration | Looks sophisticated, conveys nothing | Real data or no chart |
| 5 | Rounded shadow boxes everywhere | Generic, forgettable | Hairline borders or no border |
| 6 | Modals | Lazy interaction pattern | Inline editing, drawers, `<details>` |
| 7 | Hero-metric template (big number + small label + 4 stats + gradient) | SaaS landing template | Show real data, or nothing |
| 8 | Identical card grids (icon + heading + text × N) | Pinterest aesthetic | Vary card sizes (newspaper lead+supporting) |
| 9 | Bounce / elastic easing | Feels dated, tacky | ease-out-quart / quint / expo |
| 10 | Inter / Roboto / Open Sans / Cormorant Garamond / Fraunces | Reflex picks; create AI monoculture | See font selection procedure (§2) |
| 11 | Cyan-on-dark / purple-to-blue gradients / neon accents | The AI color palette | Brand palette only |
| 12 | Gray text on colored backgrounds | Looks washed out | Darker shade of the background hue |
| 13 | Pure `#000` or `#fff` for large areas | Never appears in nature | Tinted neutrals (chroma ≥ 0.003) |
| 14 | Numbered everything (01 · Section, 02 · Quote, ...) | False structure | Numbers only where order matters (issue #, pick rank, flow steps) |

---

## 8 · Motion

### Principles

One well-orchestrated entrance > scattered micro-interactions everywhere. Glean has almost no animation by design.

### What we do animate

| Element | Property | Duration | Easing |
|---|---|---|---|
| Mobile menu | `transform: translateX` | 220ms | ease |
| Hamburger lines | `transform`, `opacity` | 200ms | ease |
| Skip link | `top` | 180ms | ease |
| Form input focus | `border-color` | 150ms | ease |

### What we don't animate

- Page transitions (cause CLS, slow first paint)
- Hover states beyond color change
- Scroll-triggered reveals (the editorial reading rhythm is the experience)
- Decorative loops (logos, illustrations)

### `prefers-reduced-motion`

Global rule collapses all durations to 0.01ms when the OS signals motion sensitivity.

---

## 9 · Accessibility

### Standards we hit

| Criterion | Status | Note |
|---|---|---|
| WCAG AA contrast | ✅ | All body text ≥ 4.5:1 |
| WCAG 2.5.5 AAA target size | ✅ | All interactive elements ≥ 44×44 |
| Keyboard navigation | ✅ | All actions focusable + visible focus indicator |
| Skip link | ✅ | `#main` skip-link on every page |
| Heading hierarchy | ✅ | No skipped levels (h1 → h2 → h3) |
| `prefers-reduced-motion` | ✅ | Global rule |
| `prefers-color-scheme` | ✅ | Auto dark mode |
| Form labels | ✅ | Every input has explicit `<label for="">` or aria-label |
| Lang declaration | ✅ | `html lang` updates on toggle |
| Semantic HTML | ✅ | `<article>`, `<nav>`, `<aside>`, `<footer>` used per spec |
| ARIA live region | ✅ | Subscribe form status announces |
| ARIA expanded | ✅ | Hamburger, time-budget toggle |

### Standards we know we miss

- WCAG AA primary button text contrast (white on coral-500 ~ 3.3:1, passes large-text only). Documented design trade-off.
- No 404 page yet.
- No empty state for zero-pick tag pages.

---

## 10 · File Map

```
prototype/
├── DESIGN.md                  ← this document
├── design-system.html         ← live style guide (the "what")
├── styles.css                 ← all CSS; single source of truth
│
├── index.html                 ← homepage (hero + daily strip + weekly cover + subscribe)
├── daily.html                 ← daily timeline (all picks of the day)
├── weekly-1.html              ← single weekly issue body
├── weekly-list.html           ← weekly archive
├── article.html               ← single-article long-read
├── tag-edge.html              ← single tag landing
├── standards.html             ← editorial standards document
├── about.html                 ← about page
├── submit.html                ← public submission form
├── submit-success.html        ← submission confirmation
├── admin.html                 ← admin queue table
└── admin-review.html          ← admin single-item review
```

External font CDNs (loaded per-page):

- `fonts.googleapis.com` — Newsreader + JetBrains Mono
- `cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0` — LXGW WenKai (CJK)

---

## 11 · Decisions journal

Non-obvious choices worth remembering:

1. **Hero copy "每天 有2-3 条值得读的"** — kept the "有" and changed 1–3 to 2–3 at PO's instruction; the standard prescriptive grammar (omit "有", "1–3" is more honest) was overridden because the PO wanted slightly stronger promise language.
2. **Quote translation block (`.kq__tr`) marked `lang-zh` only** — original is English; in EN mode, the Chinese translation block hides entirely (no "translation echo" for English readers). Previously bug-shaped where both lang spans contained the same Chinese.
3. **Alt subtitle pattern (`.article-detail__alt`, `.thesis__alt`, `.feed-row__alt`)** — deliberately reverses the lang attribute: in ZH mode the alt shows English (cross-language preview for Chinese reader), in EN mode it shows Chinese. This is a known-quirky pattern that confuses lang-content audits, but it's a feature.
4. **No third "compare" language mode** — was prototyped, deemed unnecessary; the alt-subtitle pattern already serves cross-language preview at the title level, and forcing full-paragraph bilingual display on a list page doubles the scroll height.
5. **Single-serif decision** — followed an explicit design-system spec ("Serif 承担层级，sans 承担功能；serif 正文 400，标题 500"). Earlier the site used Cormorant Garamond + Inter; both are on the AI reflex-font blacklist.
6. **Daily strip is "lead + 2 supporting", not 3-equal** — the lead card spans 2 rows on left, gets larger title (28px vs 22px), includes bullets and editor's note. Right column is 2 small cards stacked. Newspaper logic.
7. **Section vertical rhythm via `.section--showcase`** — homepage hero (96/48) → Today (48/48 tight close) → Weekly (96-120/48 OPENS) → Subscribe (48/48 tight close) → Footer. Beat, not monotone.
8. **Footer in dark mode flips to cream** — this is editorially defensible (footer keeps its "high-contrast island" role) but readers used to "footer = same dark as rest of dark site" might be surprised. Documented; not a bug.
9. **Categories limited to 3 families (infra/data/code)** — not rainbow. Trade-off: tags like "AI" or "Tooling" don't fit cleanly; they get the default neutral badge. Acceptable.
10. **`--c-muted-soft` bumped from #8e8b82 to #737166** — was 3.32:1 on canvas (fails AA), now 4.51:1 (passes). This affects every footer link / meta text / `.text-muted-soft` element.

---

## 12 · How to make changes without breaking this

1. **Add a color?** Add a primitive in the `PRIMITIVE LAYER` block first, then map a semantic token to it. Don't introduce hex in component CSS.
2. **Add a font size?** Use an existing `--text-*` token first. Only add a new one if you actually need a new step in the scale.
3. **Add a component?** Add a top-level class with a BEM-style child pattern (`.thing__child`, `.thing--modifier`). Don't `important!` your way out of cascade conflicts.
4. **Add a breakpoint?** Use one of the 4 canonical: 640 / 768 / 1024 / 1280. New breakpoints need a justification.
5. **Add a heading level?** Pick the level that fits the document outline. Don't skip h2 → h4.
6. **Add a touch target?** ≥ 44 × 44, or document why ≤24 + spacing meets WCAG 2.5.8.
7. **Add a label?** Use the mono-600-caps-tracking treatment via `.eyebrow` or `.t-caption-up`. Don't invent a new "small text" pattern.
8. **Edit copy?** Body weight 400. Strong weight 500. No CJK text in `<span class="lang-en">` and vice versa.

---

*Last updated 2026-05-25. Document changes here when you make them; future-you and the next agent will thank you.*
