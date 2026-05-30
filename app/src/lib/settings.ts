/**
 * Runtime app settings backed by the `app_settings` D1 table. D1 is the only
 * store reachable from BOTH the Pages app (admin writes) and the queue workers
 * (reads), so the LLM-provider toggle lives here rather than in KV.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { appSettings } from "~/db/schema";
import type { ProviderName } from "./llm";

const LLM_PROVIDER_KEY = "llm_provider";

/** "auto" follows the env default (LLM_PROVIDER / free-first auto-detect); a
 *  concrete provider name overrides it for the whole pipeline. */
export type LlmProviderSetting = ProviderName | "auto";

const VALID = new Set<string>(["modelscope", "deepseek", "openai", "auto"]);

export function isLlmProviderSetting(v: string): v is LlmProviderSetting {
  return VALID.has(v);
}

/** Read the persisted default-provider toggle. Defaults to "auto" on any
 *  miss / DB error — the pipeline then falls back to the env default. */
export async function getLlmProviderSetting(db: D1Database): Promise<LlmProviderSetting> {
  try {
    const rows = await drizzle(db)
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, LLM_PROVIDER_KEY))
      .limit(1);
    const v = rows[0]?.value;
    return v && isLlmProviderSetting(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export async function setLlmProviderSetting(db: D1Database, value: LlmProviderSetting): Promise<void> {
  const now = new Date();
  await drizzle(db)
    .insert(appSettings)
    .values({ key: LLM_PROVIDER_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
}

/** Apply the toggle on top of the worker env so all downstream LLM calls honor
 *  it. Returns a shallow copy (binding references preserved) with LLM_PROVIDER
 *  overridden when the toggle is a concrete provider; "auto" leaves env as-is. */
export function withLlmProviderSetting<E extends { LLM_PROVIDER?: string }>(
  env: E,
  setting: LlmProviderSetting,
): E {
  if (setting === "auto") return env;
  return { ...env, LLM_PROVIDER: setting };
}
