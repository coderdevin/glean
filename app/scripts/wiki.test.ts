import assert from "node:assert/strict";
import {
  normalizeTopics,
  withMiscFallback,
  mergeWikiDelta,
  MISC_TITLE_EN,
  MISC_TITLE_ZH,
  type WikiTopic,
  type WikiDelta,
} from "../src/lib/wiki";

const topic = (over: Partial<WikiTopic>): WikiTopic => ({
  title_zh: "主题",
  title_en: "Topic",
  blurb_zh: "",
  blurb_en: "",
  pick_slugs: [],
  ...over,
});

// --- normalizeTopics ---

// unknown slugs filtered, dupes within a topic collapsed
{
  const out = normalizeTopics(
    [topic({ pick_slugs: ["a", "a", "ghost", "b"] })],
    new Set(["a", "b"]),
  );
  assert.deepEqual(out[0]!.pick_slugs, ["a", "b"]);
}

// topics left empty (or never filled) are dropped
{
  const out = normalizeTopics(
    [topic({ pick_slugs: ["ghost"] }), topic({ pick_slugs: [] })],
    new Set(["a"]),
  );
  assert.equal(out.length, 0);
}

// untitled topics are dropped even when they hold known slugs
{
  const out = normalizeTopics(
    [topic({ title_zh: " ", title_en: "", pick_slugs: ["a"] })],
    new Set(["a"]),
  );
  assert.equal(out.length, 0);
}

// --- withMiscFallback ---

// full coverage → untouched (same array back, no misc topic)
{
  const topics = [topic({ pick_slugs: ["a", "b"] })];
  const out = withMiscFallback(topics, ["a", "b"]);
  assert.equal(out, topics);
}

// uncovered slugs land in an appended Misc topic
{
  const out = withMiscFallback([topic({ pick_slugs: ["a"] })], ["a", "x", "y"]);
  assert.equal(out.length, 2);
  const misc = out[1]!;
  assert.equal(misc.title_en, MISC_TITLE_EN);
  assert.equal(misc.title_zh, MISC_TITLE_ZH);
  assert.deepEqual(misc.pick_slugs, ["x", "y"]);
}

// an existing Misc topic is merged into, not duplicated
{
  const out = withMiscFallback(
    [topic({ pick_slugs: ["a"] }), topic({ title_zh: MISC_TITLE_ZH, title_en: MISC_TITLE_EN, pick_slugs: ["x"] })],
    ["a", "x", "y"],
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[1]!.pick_slugs, ["x", "y"]);
}

// --- mergeWikiDelta ---

const existing: WikiTopic[] = [
  topic({ title_en: "Agents", pick_slugs: ["a1", "a2"] }),
  topic({ title_en: "Infra", pick_slugs: ["i1"] }),
];

// assignments append to the right topics; existing slugs are never removed
{
  const delta: WikiDelta = {
    assignments: [
      { slug: "n1", topics: [0] },
      { slug: "n2", topics: [0, 1] },
    ],
    new_topics: [],
  };
  const out = mergeWikiDelta(existing, delta, new Set(["n1", "n2"]));
  assert.deepEqual(out[0]!.pick_slugs, ["a1", "a2", "n1", "n2"]);
  assert.deepEqual(out[1]!.pick_slugs, ["i1", "n2"]);
  // input untouched (merge must not mutate the live wiki object)
  assert.deepEqual(existing[0]!.pick_slugs, ["a1", "a2"]);
}

// slugs outside the allowed set and out-of-range topic indexes are ignored
{
  const delta: WikiDelta = {
    assignments: [
      { slug: "evil", topics: [0] },
      { slug: "n1", topics: [99, -1, 1.5 as unknown as number, 1] },
    ],
    new_topics: [],
  };
  const out = mergeWikiDelta(existing, delta, new Set(["n1"]));
  assert.deepEqual(out[0]!.pick_slugs, ["a1", "a2"]);
  assert.deepEqual(out[1]!.pick_slugs, ["i1", "n1"]);
}

// new topics are appended, restricted to allowed slugs, dropped when empty
{
  const delta: WikiDelta = {
    assignments: [],
    new_topics: [
      topic({ title_en: "Fresh", pick_slugs: ["n1", "ghost"] }),
      topic({ title_en: "Empty", pick_slugs: ["ghost"] }),
    ],
  };
  const out = mergeWikiDelta(existing, delta, new Set(["n1"]));
  assert.equal(out.length, 3);
  assert.equal(out[2]!.title_en, "Fresh");
  assert.deepEqual(out[2]!.pick_slugs, ["n1"]);
}

// duplicate assignment of an already-present slug is a no-op
{
  const delta: WikiDelta = { assignments: [{ slug: "n1", topics: [0, 0] }], new_topics: [] };
  const out = mergeWikiDelta(existing, delta, new Set(["n1"]));
  assert.deepEqual(out[0]!.pick_slugs, ["a1", "a2", "n1"]);
}

// end-to-end shape of one increment: merge then misc-fallback guarantees
// every new slug is reachable
{
  const delta: WikiDelta = { assignments: [{ slug: "n1", topics: [1] }], new_topics: [] };
  const batch = ["n1", "n2", "n3"];
  const merged = mergeWikiDelta(existing, delta, new Set(batch));
  const out = withMiscFallback(merged, batch);
  const covered = new Set(out.flatMap((t) => t.pick_slugs));
  for (const s of batch) assert.ok(covered.has(s), `${s} must be covered`);
  assert.equal(out[out.length - 1]!.title_en, MISC_TITLE_EN);
  assert.deepEqual(out[out.length - 1]!.pick_slugs, ["n2", "n3"]);
}

console.log("wiki.test.ts passed");
