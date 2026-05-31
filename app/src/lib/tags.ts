/**
 * Tag normalization for the self-growing taxonomy.
 *
 * The LLM proposes tags freely from article/repo content (see the analysis
 * prompts in llm.ts) rather than picking from a fixed whitelist. Each proposed
 * tag carries a slug plus the bilingual display name and family the tag landing
 * pages need. These helpers sanitize that raw, model-supplied list before it
 * touches the DB: slugs are coerced to a safe ascii kebab-case form, families
 * are validated, missing names are derived, duplicates collapse, and the list
 * is capped. ingest.ts then upserts the survivors into the `tags` table.
 */
import { CATEGORIES, type Category } from "../db/schema";

const FAMILIES = new Set<string>(CATEGORIES);
const MAX_TAGS = 4;
const MAX_SLUG_LEN = 40;

export interface NormalizedTag {
  slug: string;
  nameZh: string;
  nameEn: string;
  family: Category;
}

/** Coerce an arbitrary string to a safe slug: lowercase ascii kebab-case.
 *  Non-alphanumeric runs (including CJK, which can't be a URL slug) collapse
 *  to a single dash; leading/trailing dashes are trimmed. Returns "" when
 *  nothing usable survives — the caller drops those. */
export function normalizeSlug(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ""); // a trailing dash can reappear after the length slice
}

/** Title-case a slug for an English display-name fallback ("vector-db" → "Vector Db"). */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Validate + normalize the model's proposed tags.
 *
 * @param raw            whatever the LLM emitted for `tags` (expected: an array
 *                       of {slug, name_zh, name_en, family}); tolerant of null,
 *                       non-arrays, and malformed entries.
 * @param fallbackFamily the analysis category, used when a tag's family is
 *                       missing or not one of infra/data/code.
 * @returns valid normalized tags (deduped by slug, capped at MAX_TAGS) and the
 *          raw slug strings that failed normalization (for logging).
 */
export function sanitizeProposedTags(
  raw: unknown,
  fallbackFamily: Category,
): { valid: NormalizedTag[]; dropped: string[] } {
  if (!Array.isArray(raw)) return { valid: [], dropped: [] };

  const valid: NormalizedTag[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    // A bare string (model variance — it ignored the object schema) is treated
    // as a slug with derived names and the fallback family.
    const t: Record<string, unknown> =
      typeof entry === "string"
        ? { slug: entry }
        : entry && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : {};
    const rawSlug = typeof t.slug === "string" ? t.slug : "";
    const slug = normalizeSlug(rawSlug);
    if (!slug) {
      if (rawSlug.trim()) dropped.push(rawSlug.trim());
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);

    const family = (typeof t.family === "string" && FAMILIES.has(t.family)
      ? t.family
      : fallbackFamily) as Category;
    const nameZh = typeof t.name_zh === "string" && t.name_zh.trim() ? t.name_zh.trim() : slug;
    const nameEn =
      typeof t.name_en === "string" && t.name_en.trim() ? t.name_en.trim() : titleCaseSlug(slug);

    valid.push({ slug, nameZh, nameEn, family });
    if (valid.length >= MAX_TAGS) break;
  }

  return { valid, dropped };
}
