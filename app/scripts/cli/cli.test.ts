import assert from "node:assert/strict";
import { parseSubmitLocation, submitErrorMessage } from "./lib/parseSubmit";
import { truncate, table, renderPicksTable, filterTopics, renderWikiTopics } from "./lib/render";
import type { WikiTopic } from "./lib/api";

// --- parseSubmitLocation ---------------------------------------------------
assert.deepEqual(parseSubmitLocation("/submit/success?id=01ARZ3NDEKTSV4RRFFQ69G5FAV"), {
  kind: "submitted",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
});
assert.deepEqual(parseSubmitLocation("/submit/success?id=01ARZ&dup=1"), { kind: "duplicate", id: "01ARZ" });
assert.deepEqual(parseSubmitLocation("/a/some-slug"), { kind: "published", slug: "some-slug" });
assert.deepEqual(parseSubmitLocation("/submit?error=rate_limit"), { kind: "error", code: "rate_limit" });
assert.deepEqual(parseSubmitLocation(null), { kind: "error", code: "no_location" });
assert.deepEqual(parseSubmitLocation("/submit/success"), { kind: "error", code: "no_id" });
assert.deepEqual(parseSubmitLocation("/weird/path"), { kind: "error", code: "unexpected_redirect" });
// absolute URL form (some servers return absolute Location)
assert.deepEqual(parseSubmitLocation("https://glean.smartcoder.ai/submit/success?id=ABC"), {
  kind: "submitted",
  id: "ABC",
});
assert.match(submitErrorMessage("rate_limit"), /rate limit/i);
assert.match(submitErrorMessage("nonsense"), /nonsense/);

// --- render helpers --------------------------------------------------------
assert.equal(truncate("hello", 10), "hello");
assert.equal(truncate("hello world", 5), "hell…");
{
  const t = table([["a", "1"], ["bb", "22"]], ["x", "y"]);
  const lines = t.split("\n");
  assert.equal(lines.length, 4); // header + sep + 2 rows
  assert.match(lines[0]!, /^x/);
}
assert.equal(renderPicksTable([], "en"), "(no matching picks)");

// --- wiki topic filtering --------------------------------------------------
const topics: WikiTopic[] = [
  { title_zh: "智能体", title_en: "Agents", blurb_zh: "关于智能体", blurb_en: "about autonomous agents", pick_slugs: ["a", "b"] },
  { title_zh: "数据库", title_en: "Databases", blurb_zh: "存储", blurb_en: "storage engines", pick_slugs: ["c"] },
];
// no query → all topics
assert.equal(filterTopics(topics, undefined).length, 2);
// match on en title
assert.deepEqual(filterTopics(topics, "agents").map((t) => t.title_en), ["Agents"]);
// match on en blurb, case-insensitive
assert.deepEqual(filterTopics(topics, "STORAGE").map((t) => t.title_en), ["Databases"]);
// match on zh title
assert.deepEqual(filterTopics(topics, "数据库").map((t) => t.title_en), ["Databases"]);
// no match → empty
assert.equal(filterTopics(topics, "rust").length, 0);
// renderer includes the pick count and the title
{
  const out = renderWikiTopics(topics, "en");
  assert.match(out, /Agents {2}\(2\)/);
  assert.match(out, /about autonomous agents/);
  assert.equal(renderWikiTopics([], "en"), "");
}

console.log("# glean cli unit assertions passed");
