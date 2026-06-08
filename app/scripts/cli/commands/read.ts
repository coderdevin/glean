import type { Config } from "../lib/config";
import { parseFlags } from "../lib/args";
import { getPick } from "../lib/api";
import { renderPick } from "../lib/render";
import { CliError } from "../lib/errors";

export const usage = "glean read <slug> [--lang zh|en|both] [--json]";

export async function run(argv: string[], config: Config): Promise<number> {
  const { values, positionals } = parseFlags(argv, {
    lang: { type: "string" },
    json: { type: "boolean" },
  });
  const slug = positionals[0];
  if (!slug) throw new CliError(`usage: ${usage}`);

  const lang = values.lang === "en" ? "en" : values.lang === "zh" ? "zh" : "both";
  const pick = await getPick(config, slug);

  if (values.json) {
    console.log(JSON.stringify(pick, null, 2));
  } else {
    console.log(renderPick(pick, lang));
  }
  return 0;
}
