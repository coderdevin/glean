/**
 * Self-growing category taxonomy. Like tags (see tags.ts), `category` is no
 * longer a fixed infra/data/code enum: the LLM proposes one freely per
 * submission and ingest upserts new ones into the `categories` table. category
 * and tags.family share this single taxonomy.
 *
 * Categories drive the badge color system. The 3 original families
 * (infra/data/code) keep their hand-tuned brand colors (stored in the table);
 * any new category gets a deterministic OKLCH color derived from its slug, so
 * the color-scan design keeps working without per-category CSS.
 */
import { normalizeSlug, titleCaseSlug } from "./tags";

export interface NormalizedCategory {
  slug: string;
  nameZh: string;
  nameEn: string;
}

/** Same slug rules as tags: lowercase ascii kebab-case, else "". */
export function normalizeCategorySlug(raw: string): string {
  return normalizeSlug(raw);
}

/**
 * Validate + normalize the model's proposed category. Accepts the object form
 * `{ slug, name_zh, name_en }`, a bare string (legacy enum value), or garbage.
 * An unusable/empty slug falls back entirely to `fallbackSlug` (its names
 * derived from that slug).
 */
export function sanitizeCategory(raw: unknown, fallbackSlug: string): NormalizedCategory {
  let rawSlug = "";
  let nameZhIn = "";
  let nameEnIn = "";
  if (typeof raw === "string") {
    rawSlug = raw;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    rawSlug = typeof o.slug === "string" ? o.slug : "";
    nameZhIn = typeof o.name_zh === "string" ? o.name_zh : "";
    nameEnIn = typeof o.name_en === "string" ? o.name_en : "";
  }

  const slug = normalizeSlug(rawSlug);
  if (!slug) {
    return { slug: fallbackSlug, nameZh: fallbackSlug, nameEn: titleCaseSlug(fallbackSlug) };
  }
  return {
    slug,
    nameZh: nameZhIn.trim() || slug,
    nameEn: nameEnIn.trim() || titleCaseSlug(slug),
  };
}

/** Resolve a category's badge color: the stored (hand-tuned) color if any, else
 *  a deterministic light OKLCH derived from the slug — same slug → same color. */
export function categoryColor(slug: string, storedColor?: string | null): string {
  const stored = storedColor?.trim();
  if (stored) return stored;
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (Math.imul(h, 31) + slug.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // Light, low-chroma fill that reads as a pastel badge bg under dark text.
  return `oklch(0.92 0.05 ${hue})`;
}

/** The 3 original families keep their hand-tuned CSS classes (teal/amber/coral)
 *  for zero visual change; any new category gets an inline derived color. */
const BRAND_FAMILIES = new Set(["infra", "data", "code"]);

/** Badge presentation for a category slug: either the brand CSS class (and no
 *  inline style) or an inline background for a self-grown category. */
export function categoryBadge(slug: string): { className: string; style: string } {
  if (BRAND_FAMILIES.has(slug)) return { className: `badge--cat-${slug}`, style: "" };
  return { className: "", style: `background:${categoryColor(slug)};color:var(--c-ink)` };
}
