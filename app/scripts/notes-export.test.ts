import assert from "node:assert/strict";
import { notesToMarkdown } from "../src/lib/notes-export";

// empty → just the heading
{
  const md = notesToMarkdown([], "我的笔记");
  assert.equal(md, "# 我的笔记\n");
}

// one article, highlight with annotation + highlight without
{
  const md = notesToMarkdown([
    {
      title: "Designing Data-Intensive Apps",
      url: "https://example.com/a/ddia",
      notes: [
        { exact: "Reliability means\n the system works", note: "  core definition  " },
        { exact: "highlight only", note: null },
      ],
    },
  ]);
  const expected = [
    "# 我的笔记",
    "",
    "## Designing Data-Intensive Apps",
    "https://example.com/a/ddia",
    "",
    "> Reliability means the system works", // newline collapsed
    "",
    "core definition", // trimmed
    "",
    "> highlight only",
    "",
  ].join("\n");
  assert.equal(md, expected);
}

// custom heading + multiple groups
{
  const md = notesToMarkdown(
    [
      { title: "A", url: "u1", notes: [{ exact: "x" }] },
      { title: "B", url: "u2", notes: [{ exact: "y" }] },
    ],
    "My notes",
  );
  assert.ok(md.startsWith("# My notes\n"));
  assert.ok(md.includes("## A"));
  assert.ok(md.includes("## B"));
  assert.ok(md.endsWith("\n"));
}

console.log("notes-export markdown assertions passed");
