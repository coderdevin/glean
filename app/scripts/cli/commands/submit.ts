import type { Config } from "../lib/config";
import { parseFlags } from "../lib/args";
import { submitLink } from "../lib/api";
import { submitErrorMessage } from "../lib/parseSubmit";
import { watchStatus } from "../lib/watch";
import { CliError } from "../lib/errors";

export const usage = "glean submit <url> [--note <text>] [--as <name>] [--watch] [--json]";

export async function run(argv: string[], config: Config): Promise<number> {
  const { values, positionals } = parseFlags(argv, {
    note: { type: "string" },
    as: { type: "string" },
    watch: { type: "boolean" },
    json: { type: "boolean" },
  });
  const url = positionals[0];
  if (!url) throw new CliError(`usage: ${usage}`);

  const json = !!values.json;
  const outcome = await submitLink(config, {
    url,
    note: values.note as string | undefined,
    submitter: values.as as string | undefined,
  });

  if (json) console.log(JSON.stringify(outcome, null, 2));

  switch (outcome.kind) {
    case "published":
      if (!json) console.log(`already published → ${config.baseUrl}/a/${outcome.slug}`);
      return 0;
    case "error":
      throw new CliError(submitErrorMessage(outcome.code), outcome.code === "rate_limit" ? 3 : 1);
    case "duplicate":
      if (!json) console.log(`already in flight → ${outcome.id}`);
      break;
    case "submitted":
      if (!json) console.log(`submitted → ${outcome.id}`);
      break;
  }

  if (values.watch) return watchStatus(config, outcome.id, json);
  if (!json) console.log(`track it: glean status ${outcome.id} --watch`);
  return 0;
}
