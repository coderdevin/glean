/** Thin wrapper over node:util parseArgs that turns parse failures into CliError. */
import { parseArgs } from "node:util";
import { CliError } from "./errors";

type OptionConfig = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

export interface Parsed {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export function parseFlags(argv: string[], options: OptionConfig): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Parsed["values"], positionals };
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

/** Parse a flag value as a positive integer, or throw. */
export function intFlag(v: string | boolean | undefined, name: string): number | undefined {
  if (v === undefined || v === true || v === false) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError(`--${name} must be a non-negative integer`);
  return n;
}
