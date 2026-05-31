import assert from "node:assert/strict";
import { normalizeSlug, sanitizeProposedTags } from "../src/lib/tags";

// --- normalizeSlug ---
assert.equal(normalizeSlug("Vector DB"), "vector-db"); // spaces → dash, lowercased
assert.equal(normalizeSlug("  RAG  "), "rag"); // trim + lowercase
assert.equal(normalizeSlug("k8s"), "k8s"); // alnum preserved
assert.equal(normalizeSlug("---weird---"), "weird"); // trim leading/trailing dashes
assert.equal(normalizeSlug("Retrieval__Augmented  Gen"), "retrieval-augmented-gen"); // collapse runs
assert.equal(normalizeSlug("机器学习"), ""); // non-ascii stripped → empty (lives in name_zh)
assert.equal(normalizeSlug(""), ""); // empty stays empty

// --- sanitizeProposedTags ---

// happy path: well-formed tags pass through, names trimmed, family kept
{
  const { valid, dropped } = sanitizeProposedTags(
    [{ slug: "rag", name_zh: " 检索增强 ", name_en: " RAG ", family: "data" }],
    "code",
  );
  assert.deepEqual(valid, [{ slug: "rag", nameZh: "检索增强", nameEn: "RAG", family: "data" }]);
  assert.deepEqual(dropped, []);
}

// invalid family → falls back to the analysis category
{
  const { valid } = sanitizeProposedTags(
    [{ slug: "cli", name_zh: "命令行", name_en: "CLI", family: "bogus" }],
    "code",
  );
  assert.equal(valid[0]!.family, "code");
}

// missing names → derive: nameZh falls back to slug, nameEn to titlecased slug
{
  const { valid } = sanitizeProposedTags(
    [{ slug: "vector-db", name_zh: "", name_en: "", family: "data" }],
    "code",
  );
  assert.equal(valid[0]!.nameZh, "vector-db");
  assert.equal(valid[0]!.nameEn, "Vector Db");
}

// slug normalized before use; the normalized form is what lands
{
  const { valid } = sanitizeProposedTags(
    [{ slug: "Vector DB", name_zh: "向量库", name_en: "Vector DB", family: "data" }],
    "code",
  );
  assert.equal(valid[0]!.slug, "vector-db");
}

// non-normalizable slug (non-ascii / empty) → dropped, recorded by raw value
{
  const { valid, dropped } = sanitizeProposedTags(
    [{ slug: "机器学习", name_zh: "机器学习", name_en: "ML", family: "code" }],
    "code",
  );
  assert.deepEqual(valid, []);
  assert.deepEqual(dropped, ["机器学习"]);
}

// dedupe by normalized slug, keep first occurrence
{
  const { valid } = sanitizeProposedTags(
    [
      { slug: "rag", name_zh: "检索增强", name_en: "RAG", family: "data" },
      { slug: "RAG", name_zh: "重复", name_en: "Dup", family: "code" },
    ],
    "code",
  );
  assert.equal(valid.length, 1);
  assert.equal(valid[0]!.nameZh, "检索增强");
}

// cap at 4 tags
{
  const { valid } = sanitizeProposedTags(
    [
      { slug: "a", name_zh: "a", name_en: "A", family: "code" },
      { slug: "b", name_zh: "b", name_en: "B", family: "code" },
      { slug: "c", name_zh: "c", name_en: "C", family: "code" },
      { slug: "d", name_zh: "d", name_en: "D", family: "code" },
      { slug: "e", name_zh: "e", name_en: "E", family: "code" },
    ],
    "code",
  );
  assert.equal(valid.length, 4);
}

// tolerant of garbage input (null / non-array / non-object entries)
{
  assert.deepEqual(sanitizeProposedTags(null, "code"), { valid: [], dropped: [] });
  assert.deepEqual(sanitizeProposedTags("nope", "code"), { valid: [], dropped: [] });
  const { valid } = sanitizeProposedTags(
    [null, 42, { slug: "ok", name_zh: "好", name_en: "OK", family: "code" }],
    "code",
  );
  assert.equal(valid.length, 1);
  assert.equal(valid[0]!.slug, "ok");
}

// bare string entry (model variance) → treated as a slug, names derived, fallback family
{
  const { valid } = sanitizeProposedTags(["Vector DB"], "data");
  assert.deepEqual(valid, [{ slug: "vector-db", nameZh: "vector-db", nameEn: "Vector Db", family: "data" }]);
}

console.log("# tags normalization + sanitization assertions passed");
