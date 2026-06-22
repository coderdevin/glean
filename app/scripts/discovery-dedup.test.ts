// app/scripts/discovery-dedup.test.ts
import assert from "node:assert/strict";
import { partitionUnseen, type Candidate } from "../src/lib/discovery";

const c = (url: string, source = "auto:hn"): Candidate => ({ url, title: "t", snippet: "s", source });

// `known` is the set of already-normalized URLs (seen ∪ submissions ∪ picks).
// partitionUnseen dedups within the batch too (same normalized url twice).
{
  const cands = [c("https://x.example/a"), c("https://x.example/a?utm_source=z"), c("https://x.example/b")];
  // normalize fn collapses tracking params → first two share a key
  const norm = (u: string) => u.split("?")[0]!;
  const { fresh } = partitionUnseen(cands, new Set<string>(), norm);
  assert.equal(fresh.length, 2, "intra-batch dedup by normalized url");
}
{
  const cands = [c("https://x.example/a"), c("https://x.example/b")];
  const norm = (u: string) => u;
  const known = new Set(["https://x.example/a"]);
  const { fresh } = partitionUnseen(cands, known, norm);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.url, "https://x.example/b");
}

console.log("discovery-dedup.test.ts passed");
