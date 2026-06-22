// app/scripts/discovery-parsers.test.ts
import assert from "node:assert/strict";
import { parseFeed, parseHnHits, parseArxivXml } from "../src/lib/discovery";

// --- RSS 2.0 ---
{
  const xml = `<rss><channel>
    <item><title>Hello &amp; World</title><link>https://a.example/post</link>
      <description>A short blurb</description></item>
    <item><title>Second</title><link>https://b.example/2</link></item>
  </channel></rss>`;
  const out = parseFeed(xml, "rss:test");
  assert.equal(out.length, 2);
  assert.equal(out[0]!.title, "Hello & World");
  assert.equal(out[0]!.url, "https://a.example/post");
  assert.equal(out[0]!.snippet, "A short blurb");
  assert.equal(out[0]!.source, "auto:rss:test");
}

// --- Atom (link is an attribute) ---
{
  const xml = `<feed><entry><title>Atom Post</title>
    <link href="https://c.example/atom" rel="alternate"/>
    <summary>atom blurb</summary></entry></feed>`;
  const out = parseFeed(xml, "rss:atomtest");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, "https://c.example/atom");
  assert.equal(out[0]!.title, "Atom Post");
}

// --- HN Algolia ---
{
  const json = {
    hits: [
      { title: "Great post", url: "https://hn.example/x", points: 250, objectID: "1" },
      { title: "Ask HN: no url", url: null, points: 300, objectID: "2" },
      { title: "Low points", url: "https://hn.example/y", points: 40, objectID: "3" },
    ],
  };
  const out = parseHnHits(json, 100);
  assert.equal(out.length, 1, "drop null-url and sub-threshold hits");
  assert.equal(out[0]!.url, "https://hn.example/x");
  assert.equal(out[0]!.source, "auto:hn");
}

// --- arXiv Atom ---
{
  const xml = `<feed><entry>
    <title>Deep Thing</title>
    <id>http://arxiv.org/abs/2406.12345v1</id>
    <summary>We propose a thing.</summary></entry></feed>`;
  const out = parseArxivXml(xml);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, "http://arxiv.org/abs/2406.12345v1");
  assert.equal(out[0]!.title, "Deep Thing");
  assert.equal(out[0]!.source, "auto:arxiv");
}

console.log("discovery-parsers.test.ts passed");
