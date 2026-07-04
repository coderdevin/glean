// app/scripts/album-import-plan.test.ts
// Seam test for planAlbumImport — the album analog of partitionUnseen
// (see discovery-dedup.test.ts). Pure: candidates + a map of each known
// normalized URL's disposition + an injected normalizer → enqueue / adopt /
// skip partition. No DB, no network.
import assert from "node:assert/strict";
import { planAlbumImport, type AlbumCandidate, type KnownUrl } from "../src/lib/albums";

const c = (url: string, title = "t"): AlbumCandidate => ({ url, title });
// strip query string so ?utm collapses to the same key
const norm = (u: string) => u.split("?")[0]!;

// 1. Fresh URLs enqueue; input order is preserved.
{
  const plan = planAlbumImport([c("https://x/a"), c("https://x/b")], new Map(), norm);
  assert.deepEqual(plan.toEnqueue.map((x) => x.url), ["https://x/a", "https://x/b"]);
  assert.equal(plan.toAdopt.length, 0);
  assert.equal(plan.skipped.length, 0);
}

// 2. Intra-batch dedup by normalized URL — second occurrence is skipped.
{
  const plan = planAlbumImport(
    [c("https://x/a"), c("https://x/a?utm_source=z"), c("https://x/b")],
    new Map(),
    norm,
  );
  assert.equal(plan.toEnqueue.length, 2, "a (once) + b");
  assert.equal(plan.skipped.length, 1, "duplicate a");
}

// 3. An in-flight submission (already processing) is skipped, not re-enqueued.
{
  const known = new Map<string, KnownUrl>([["https://x/a", { kind: "in-flight" }]]);
  const plan = planAlbumImport([c("https://x/a"), c("https://x/b")], known, norm);
  assert.deepEqual(plan.toEnqueue.map((x) => x.url), ["https://x/b"]);
  assert.equal(plan.skipped.length, 1);
}

// 4. An existing Pick with NO album is adopted (carries its pickId through).
{
  const known = new Map<string, KnownUrl>([
    ["https://x/a", { kind: "pick-unowned", pickId: "P1" }],
  ]);
  const plan = planAlbumImport([c("https://x/a"), c("https://x/b")], known, norm);
  assert.deepEqual(plan.toAdopt, [{ url: "https://x/a", pickId: "P1" }]);
  assert.deepEqual(plan.toEnqueue.map((x) => x.url), ["https://x/b"]);
}

// 5. A Pick already in another album is skipped — never moved.
{
  const known = new Map<string, KnownUrl>([["https://x/a", { kind: "pick-in-album" }]]);
  const plan = planAlbumImport([c("https://x/a")], known, norm);
  assert.equal(plan.toEnqueue.length, 0);
  assert.equal(plan.toAdopt.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0]!.reason, /专辑/);
}

// 6. Unparseable URL (norm throws) is skipped, not fatal.
{
  const throwingNorm = (u: string) => {
    if (u.includes("bad")) throw new Error("bad url");
    return u;
  };
  const plan = planAlbumImport([c("https://x/bad"), c("https://x/ok")], new Map(), throwingNorm);
  assert.deepEqual(plan.toEnqueue.map((x) => x.url), ["https://x/ok"]);
  assert.equal(plan.skipped.length, 1);
}

console.log("album-import-plan.test.ts passed");
