import type { Config } from "../lib/config";
import { parseFlags, intFlag } from "../lib/args";
import { getPicks, getWiki } from "../lib/api";
import { renderPicksTable, renderWikiTopics, filterTopics } from "../lib/render";

export const usage =
  "glean query [terms…] [--tag <slug>] [--category <slug>] [--date <YYYY-MM-DD>] [--limit <n>] [--offset <n>] [--lang zh|en] [--json]";

export async function run(argv: string[], config: Config): Promise<number> {
  const { values, positionals } = parseFlags(argv, {
    tag: { type: "string" },
    category: { type: "string" },
    date: { type: "string" },
    limit: { type: "string" },
    offset: { type: "string" },
    lang: { type: "string" },
    json: { type: "boolean" },
  });

  const lang = values.lang === "en" ? "en" : "zh";
  const q = positionals.join(" ") || undefined;

  // query searches both the wiki map (curated themes) and the picks. Filters
  // (tag/category/date/offset) are pick-only, so skip the wiki when one is set.
  const filtersActive = !!(values.tag || values.category || values.date || values.offset);
  const [picksRes, wiki] = await Promise.all([
    getPicks(config, {
      q,
      tag: values.tag as string | undefined,
      category: values.category as string | undefined,
      date: values.date as string | undefined,
      limit: intFlag(values.limit, "limit"),
      offset: intFlag(values.offset, "offset"),
    }),
    filtersActive ? Promise.resolve(null) : getWiki(config).catch(() => null),
  ]);

  const topics = wiki ? filterTopics(wiki.topics, q) : [];

  if (values.json) {
    console.log(JSON.stringify({ topics, picks: picksRes }, null, 2));
  } else {
    if (topics.length > 0) {
      console.log(q ? "Wiki topics" : "Wiki map");
      console.log(renderWikiTopics(topics, lang));
      console.log("");
    }
    console.log(renderPicksTable(picksRes.items, lang));
    if (picksRes.next_offset != null) console.log(`\n… more — next page: --offset ${picksRes.next_offset}`);
  }
  return 0;
}
