/**
 * Text-quote anchoring for reader highlights — the robustness core of the
 * reading-notes feature. Pure functions, no DOM, no I/O; unit-tested via
 * scripts/anchor.test.ts.
 *
 * A highlight is stored as { exact, prefix, suffix, startOffset } against a
 * section's plain text. On re-render we re-locate it so it survives editorial
 * edits: the offset is only a hint, the quote (disambiguated by surrounding
 * context) is the source of truth. When the quote no longer exists at all the
 * highlight is "orphaned" — kept in the reader's notes, just not painted.
 */

export const CONTEXT_LEN = 32;

export interface AnchorInput {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
  startOffset: number;
}

export interface AnchorRange {
  start: number;
  end: number;
}

/**
 * Capture the surrounding context for a [start, end) range in `text`.
 * Stored alongside the quote so a later re-locate can disambiguate repeated
 * phrases. `len` chars on each side (clamped to the section bounds).
 */
export function extractContext(
  text: string,
  start: number,
  end: number,
  len: number = CONTEXT_LEN,
): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, start - len), start),
    suffix: text.slice(end, Math.min(text.length, end + len)),
  };
}

/** All indices where `needle` occurs in `haystack` (non-overlapping scan). */
function allIndicesOf(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}

/** Length of the longest common suffix of a and b (how well prefixes align). */
function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the longest common prefix of a and b (how well suffixes align). */
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Re-locate an anchored quote within `text`. Returns the [start, end) range, or
 * null when the quote is gone (orphaned).
 *
 * Strategy:
 *  1. Fast path — the stored offset still holds the exact quote.
 *  2. Otherwise find every occurrence of `exact` and pick the one whose
 *     prefix/suffix context matches best, breaking ties by nearness to the
 *     original offset. This disambiguates a phrase that repeats in the section.
 */
export function resolveAnchor(text: string, anchor: AnchorInput): AnchorRange | null {
  const { exact, startOffset } = anchor;
  if (!exact) return null;

  // Unique quote → unambiguous, regardless of where the offset drifted to.
  // (We deliberately do NOT short-circuit on the stored offset alone: after an
  //  edit a *different* occurrence of a repeated phrase can land at the old
  //  offset, so for a non-unique quote context must decide — see below.)
  const hits = allIndicesOf(text, exact);
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    const only = hits[0] as number;
    return { start: only, end: only + exact.length };
  }

  // Context-scored search over all occurrences, tie-broken by offset nearness.
  const prefix = anchor.prefix ?? "";
  const suffix = anchor.suffix ?? "";
  let best = hits[0] as number;
  let bestScore = -1;
  for (const i of hits) {
    const beforeText = text.slice(Math.max(0, i - prefix.length), i);
    const afterText = text.slice(i + exact.length, i + exact.length + suffix.length);
    const score = commonSuffixLen(prefix, beforeText) + commonPrefixLen(suffix, afterText);
    // Higher context score wins; tie → nearer the original offset.
    if (
      score > bestScore ||
      (score === bestScore && Math.abs(i - startOffset) < Math.abs(best - startOffset))
    ) {
      bestScore = score;
      best = i;
    }
  }
  return { start: best, end: best + exact.length };
}
