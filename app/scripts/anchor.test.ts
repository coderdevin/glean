import assert from "node:assert/strict";
import { resolveAnchor, extractContext } from "../src/lib/anchor";

const TEXT = "The quick brown fox jumps over the lazy dog near the river.";

// --- extractContext ---
{
  const start = TEXT.indexOf("fox");
  const end = start + "fox".length;
  const { prefix, suffix } = extractContext(TEXT, start, end, 10);
  assert.equal(prefix, "ick brown ");
  assert.equal(suffix, " jumps ove");
}

// context clamps at the string bounds
{
  const { prefix } = extractContext("hi there", 0, 2, 10);
  assert.equal(prefix, ""); // nothing before start=0
}

// --- resolveAnchor: fast path (offset unchanged) ---
{
  const start = TEXT.indexOf("brown");
  const r = resolveAnchor(TEXT, { exact: "brown", startOffset: start });
  assert.deepEqual(r, { start, end: start + 5 });
}

// --- resolveAnchor: offset drifted (editor inserted text earlier) ---
{
  const shifted = "PREAMBLE INSERTED. " + TEXT;
  const oldStart = TEXT.indexOf("lazy"); // stale offset from before the insert
  const r = resolveAnchor(shifted, {
    exact: "lazy",
    prefix: "over the ",
    suffix: " dog",
    startOffset: oldStart,
  });
  assert.ok(r, "should relocate despite drift");
  assert.equal(shifted.slice(r!.start, r!.end), "lazy");
}

// --- resolveAnchor: repeated phrase disambiguated by context ---
{
  const t = "set the value. then reset the value here and the value there.";
  // Target the THIRD "the value" (…and the value there), via suffix context.
  const third = t.lastIndexOf("the value");
  const r = resolveAnchor(t, {
    exact: "the value",
    prefix: "and ",
    suffix: " there",
    startOffset: 0, // deliberately wrong offset → forces context search
  });
  assert.ok(r);
  assert.equal(r!.start, third, "context picks the right occurrence");
}

// --- resolveAnchor: stale offset must NOT hijack a non-unique quote ---
// Regression: the old offset fast-path returned whatever sat at startOffset
// without checking context, so an edit that slid a *different* occurrence onto
// the stored offset would mis-anchor. Context must win for repeated quotes.
{
  const t = "alpha the model beta. gamma the model delta.";
  const second = t.lastIndexOf("the model"); // reader highlighted occurrence #2
  const firstOffset = t.indexOf("the model"); // stale offset now points at #1
  const r = resolveAnchor(t, {
    exact: "the model",
    prefix: "gamma ",
    suffix: " delta",
    startOffset: firstOffset,
  });
  assert.ok(r);
  assert.equal(r!.start, second, "context picks #2 even though offset points at #1");
}

// --- resolveAnchor: orphan (quote gone) ---
{
  const r = resolveAnchor("completely different text now", {
    exact: "brown",
    startOffset: 4,
  });
  assert.equal(r, null);
}

// empty exact → null
assert.equal(resolveAnchor(TEXT, { exact: "", startOffset: 0 }), null);

console.log("anchor resolve + context assertions passed");
