/**
 * CLI config — resolved from env first, then an optional ~/.glean/config.json,
 * then a built-in default. The CLI talks to Glean purely over HTTP, so all it
 * needs is a base URL (which surface to hit). No D1 / wrangler / Cloudflare
 * Access involved.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
}

export const DEFAULTS = {
  baseUrl: "https://glean.smartcoder.ai",
} as const;

interface ConfigFile {
  baseUrl?: string;
}

function readConfigFile(): ConfigFile {
  const path = process.env.GLEAN_CONFIG ?? join(homedir(), ".glean", "config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const file = readConfigFile();
  const baseUrl = (process.env.GLEAN_BASE_URL ?? file.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, "");
  return { baseUrl };
}
