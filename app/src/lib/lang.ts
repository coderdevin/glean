/**
 * Cheap language detection shared by every extractor (X / GitHub / Readability
 * / Jina). Samples the first 500 chars and compares CJK vs Latin density.
 * Kept deliberately simple — it only feeds the bilingual translation direction
 * in the LLM prompts, not anything user-facing.
 */
export function detectLang(text: string): "zh" | "en" | "other" {
  const sample = text.slice(0, 500);
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > latin * 0.3) return "zh";
  if (latin > cjk * 2) return "en";
  return "other";
}
