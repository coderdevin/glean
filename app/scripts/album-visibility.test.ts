// app/scripts/album-visibility.test.ts
// Seam test for the /a/<slug> visibility rule: album picks are gated behind
// their album's publication; normal picks are visible (caller already filters
// to published). Pure.
import assert from "node:assert/strict";
import { isPickPubliclyVisible } from "../src/lib/albums";

// Normal (non-album) pick — visible.
assert.equal(isPickPubliclyVisible({ albumId: null }), true);
// Album pick, album still a draft — hidden.
assert.equal(isPickPubliclyVisible({ albumId: "A1", albumStatus: "draft" }), false);
// Album pick, album published — visible.
assert.equal(isPickPubliclyVisible({ albumId: "A1", albumStatus: "published" }), true);
// Album pick, album status unknown — fail-closed (hidden).
assert.equal(isPickPubliclyVisible({ albumId: "A1", albumStatus: null }), false);
assert.equal(isPickPubliclyVisible({ albumId: "A1" }), false);

console.log("album-visibility.test.ts passed");
