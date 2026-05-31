import assert from "node:assert/strict";
import { normalizeCategorySlug, sanitizeCategory, categoryColor, categoryBadge } from "../src/lib/category";

// --- normalizeCategorySlug (shares the tag slug rules) ---
assert.equal(normalizeCategorySlug("AI Agents"), "ai-agents");
assert.equal(normalizeCategorySlug("  Infra  "), "infra");
assert.equal(normalizeCategorySlug("机器学习"), ""); // non-ascii → empty

// --- sanitizeCategory ---

// object form: slug normalized, names trimmed/kept
assert.deepEqual(
  sanitizeCategory({ slug: "AI Agents", name_zh: " AI 智能体 ", name_en: " AI Agents " }, "code"),
  { slug: "ai-agents", nameZh: "AI 智能体", nameEn: "AI Agents" },
);

// object with missing names → derive (zh=slug, en=TitleCase)
assert.deepEqual(
  sanitizeCategory({ slug: "vector-db" }, "code"),
  { slug: "vector-db", nameZh: "vector-db", nameEn: "Vector Db" },
);

// bare string (legacy enum value) → slug + derived names
assert.deepEqual(sanitizeCategory("infra", "code"), { slug: "infra", nameZh: "infra", nameEn: "Infra" });

// unusable slug (non-ascii) → fall back entirely to fallbackSlug
assert.deepEqual(
  sanitizeCategory({ slug: "机器学习", name_zh: "机器学习", name_en: "ML" }, "code"),
  { slug: "code", nameZh: "code", nameEn: "Code" },
);

// garbage → fallback
assert.deepEqual(sanitizeCategory(null, "code"), { slug: "code", nameZh: "code", nameEn: "Code" });
assert.deepEqual(sanitizeCategory(42, "data"), { slug: "data", nameZh: "data", nameEn: "Data" });

// --- categoryColor ---

// stored color wins (the seeded infra/data/code brand colors)
assert.equal(categoryColor("infra", "oklch(0.9 0.05 200)"), "oklch(0.9 0.05 200)");
assert.equal(categoryColor("infra", "  oklch(0.9 0.05 200)  "), "oklch(0.9 0.05 200)");

// no stored color → deterministic OKLCH derived from the slug
const c1 = categoryColor("ai-agents");
const c2 = categoryColor("ai-agents");
assert.equal(c1, c2); // deterministic
assert.ok(c1.startsWith("oklch("), `expected oklch color, got ${c1}`);

// blank stored color falls through to derivation
assert.ok(categoryColor("ai-agents", "  ").startsWith("oklch("));

// different slugs generally get different hues
assert.notEqual(categoryColor("ai-agents"), categoryColor("databases"));

// --- categoryBadge: brand 3 keep their CSS class; new ones get inline color ---
assert.deepEqual(categoryBadge("infra"), { className: "badge--cat-infra", style: "" });
assert.deepEqual(categoryBadge("data"), { className: "badge--cat-data", style: "" });
assert.deepEqual(categoryBadge("code"), { className: "badge--cat-code", style: "" });
{
  const b = categoryBadge("ai-agents");
  assert.equal(b.className, "");
  assert.ok(b.style.includes("background:oklch("), `expected inline bg, got ${b.style}`);
}

console.log("# category normalization + color assertions passed");
