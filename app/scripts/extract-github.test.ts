import assert from "node:assert/strict";
import { parseRepoUrl, isGithubRepoUrl, isGithubHost } from "../src/lib/extract-github";
import { normalizeUrl } from "../src/lib/normalize-url";

// --- repo URLs that SHOULD parse ---
assert.deepEqual(parseRepoUrl("https://github.com/Lum1104/Understand-Anything"), {
  owner: "Lum1104",
  repo: "Understand-Anything",
});
// deep paths collapse to the repo root
assert.deepEqual(parseRepoUrl("https://github.com/Lum1104/Understand-Anything/tree/main/src"), {
  owner: "Lum1104",
  repo: "Understand-Anything",
});
assert.deepEqual(parseRepoUrl("https://github.com/facebook/react/blob/main/README.md"), {
  owner: "facebook",
  repo: "react",
});
// www. host + .git suffix + tab query
assert.deepEqual(parseRepoUrl("https://www.github.com/foo/bar.git?tab=readme-ov-file"), {
  owner: "foo",
  repo: "bar",
});

// --- URLs that should NOT parse as repos ---
assert.equal(parseRepoUrl("https://github.com"), null);
assert.equal(parseRepoUrl("https://github.com/Lum1104"), null); // owner only
assert.equal(parseRepoUrl("https://github.com/features/actions"), null); // reserved route
assert.equal(parseRepoUrl("https://github.com/settings/profile"), null);
assert.equal(parseRepoUrl("https://gitlab.com/foo/bar"), null); // not github
assert.equal(parseRepoUrl("https://example.com/foo/bar"), null);

// --- isGithubRepoUrl mirrors parseRepoUrl ---
assert.equal(isGithubRepoUrl("https://github.com/foo/bar"), true);
assert.equal(isGithubRepoUrl("https://github.com/features/actions"), false);
assert.equal(isGithubRepoUrl("not a url"), false);

// --- isGithubHost (used in llm.ts prompt selection) ---
assert.equal(isGithubHost("github.com"), true);
assert.equal(isGithubHost("www.github.com"), true);
assert.equal(isGithubHost("raw.githubusercontent.com"), false);
assert.equal(isGithubHost("gist.github.com"), false);
assert.equal(isGithubHost(undefined), false);

// --- normalizeUrl collapses github repo URLs to the canonical root ---
assert.equal(
  normalizeUrl("https://github.com/Lum1104/Understand-Anything/tree/main/src"),
  "https://github.com/Lum1104/Understand-Anything",
);
assert.equal(
  normalizeUrl("https://www.github.com/foo/bar.git?tab=readme-ov-file"),
  "https://github.com/foo/bar",
);
assert.equal(
  normalizeUrl("https://github.com/facebook/react/blob/main/README.md#hash"),
  "https://github.com/facebook/react",
);
// non-repo github routes are left alone (just host/fragment hygiene)
assert.equal(
  normalizeUrl("https://github.com/features/actions"),
  "https://github.com/features/actions",
);
// non-github URLs unaffected
assert.equal(
  normalizeUrl("https://example.com/a/b/c?utm_source=x"),
  "https://example.com/a/b/c",
);

console.log("# extract-github detection assertions passed");
