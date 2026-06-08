#!/usr/bin/env -S pnpm exec tsx
/**
 * Glean CLI — a terminal-native, dual-use (human + `--json`) surface over the
 * public Glean API, modeled on Karpathy's LLM-Wiki verbs: ingest / query / ask /
 * lint. Talks to Glean purely over HTTP (no D1/wrangler/Access). Run any command
 * with `--json` to pipe machine output into another tool or agent.
 */
import { loadConfig, type Config } from "./lib/config";
import { CliError } from "./lib/errors";
import * as submit from "./commands/submit";
import * as status from "./commands/status";
import * as query from "./commands/query";
import * as read from "./commands/read";

interface Command {
  run: (argv: string[], config: Config) => Promise<number>;
  usage: string;
}

const COMMANDS: Record<string, Command> = { submit, status, query, read };

const HELP = `glean — CLI for the Glean bilingual link wiki

Usage: glean <command> [args]   (add --json to any command for machine output)

Commands:
  submit <url>     submit a link into the editorial pipeline (--watch to follow)
  status <id>      poll a submission's pipeline status (--watch to follow)
  query [terms]    search the wiki map + published picks (--tag --category --date --limit --offset)
  read <slug>      print a pick's full bilingual body (--lang zh|en|both)

Config (env first, then ~/.glean/config.json):
  GLEAN_BASE_URL        which surface to hit (default https://glean.smartcoder.ai)
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  const command = COMMANDS[cmd];
  if (!command) {
    console.error(`glean: unknown command '${cmd}'\n`);
    console.log(HELP);
    return 1;
  }
  return command.run(rest, loadConfig());
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof CliError) {
      console.error(`glean: ${err.message}`);
      process.exit(err.code);
    }
    console.error("glean: unexpected error:", (err as Error).stack ?? String(err));
    process.exit(1);
  });
