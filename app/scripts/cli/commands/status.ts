import type { Config } from "../lib/config";
import { parseFlags } from "../lib/args";
import { getStatus } from "../lib/api";
import { renderStatus } from "../lib/render";
import { watchStatus } from "../lib/watch";
import { CliError } from "../lib/errors";

export const usage = "glean status <id> [--watch] [--json]";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export async function run(argv: string[], config: Config): Promise<number> {
  const { values, positionals } = parseFlags(argv, {
    watch: { type: "boolean" },
    json: { type: "boolean" },
  });
  const id = positionals[0];
  if (!id) throw new CliError(`usage: ${usage}`);
  if (!ULID.test(id)) throw new CliError("not a valid submission id (26-char ULID)");

  const json = !!values.json;
  if (values.watch) return watchStatus(config, id, json);

  const v = await getStatus(config, id);
  if (json) {
    console.log(JSON.stringify({ id, ...v }, null, 2));
  } else {
    console.log(renderStatus(id, v));
  }
  return v.status === "rejected" || v.status === "failed" ? 5 : 0;
}
