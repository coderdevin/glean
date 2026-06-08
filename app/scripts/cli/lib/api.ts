/** Network layer — typed fetchers against the Glean public HTTP API. */
import { z } from "zod";
import type { Config } from "./config";
import { CliError } from "./errors";
import { parseSubmitLocation, type SubmitOutcome } from "./parseSubmit";

async function getJson(config: Config, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new CliError(`cannot reach ${config.baseUrl} (${(err as Error).message})`);
  }
  if (res.status === 404) throw new CliError("not found", 4);
  if (!res.ok) throw new CliError(`server returned ${res.status} for ${path}`);
  try {
    return await res.json();
  } catch {
    throw new CliError(`server returned non-JSON for ${path}`);
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CliError(`unexpected ${what} shape from server: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

// --- submit -----------------------------------------------------------------

export async function submitLink(
  config: Config,
  body: { url: string; note?: string; submitter?: string },
): Promise<SubmitOutcome> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  } catch (err) {
    throw new CliError(`cannot reach ${config.baseUrl} (${(err as Error).message})`);
  }
  // 303 with a Location header is the expected path; manual redirect keeps it.
  return parseSubmitLocation(res.headers.get("location"));
}

// --- status -----------------------------------------------------------------

export const StatusSchema = z.object({
  status: z.string(),
  stepIndex: z.number().optional(),
  isTerminal: z.boolean().optional(),
  headline: z.object({ zh: z.string(), en: z.string() }).optional(),
  sub: z.object({ zh: z.string(), en: z.string() }).optional(),
  hasPick: z.boolean().optional(),
});
export type StatusView = z.infer<typeof StatusSchema>;

export async function getStatus(config: Config, id: string): Promise<StatusView> {
  const data = await getJson(config, `/api/submit/status?id=${encodeURIComponent(id)}`);
  if (data && typeof data === "object" && "error" in data) {
    throw new CliError(`status lookup failed: ${(data as { error: string }).error}`, 4);
  }
  return validate(StatusSchema, data, "status");
}

// --- picks index ------------------------------------------------------------

export const PickIndexItemSchema = z.object({
  slug: z.string(),
  title_zh: z.string(),
  title_en: z.string(),
  summary_zh: z.string(),
  summary_en: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  source_url: z.string(),
  source_host: z.string(),
  read_minutes: z.number(),
  published_at: z.union([z.string(), z.null()]).optional(),
});
export type PickIndexItem = z.infer<typeof PickIndexItemSchema>;

const PicksResponseSchema = z.object({
  count: z.number(),
  items: z.array(PickIndexItemSchema),
  next_offset: z.union([z.number(), z.null()]).optional(),
});
export type PicksResponse = z.infer<typeof PicksResponseSchema>;

export interface QueryParams {
  q?: string;
  tag?: string;
  category?: string;
  date?: string;
  limit?: number;
  offset?: number;
}

export async function getPicks(config: Config, params: QueryParams): Promise<PicksResponse> {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.tag) sp.set("tag", params.tag);
  if (params.category) sp.set("category", params.category);
  if (params.date) sp.set("date", params.date);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset !== undefined) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  const data = await getJson(config, `/api/picks${qs ? `?${qs}` : ""}`);
  return validate(PicksResponseSchema, data, "picks");
}

// --- single pick ------------------------------------------------------------

const SectionSchema = z.object({
  heading_zh: z.string().optional(),
  heading_en: z.string().optional(),
  body_zh: z.string().optional(),
  body_en: z.string().optional(),
});
export const PickSchema = z.object({
  slug: z.string(),
  title_zh: z.string(),
  title_en: z.string(),
  summary_zh: z.string(),
  summary_en: z.string(),
  bullets: z.array(z.object({ zh: z.string(), en: z.string() })).optional(),
  editor_note_zh: z.string().nullable().optional(),
  editor_note_en: z.string().nullable().optional(),
  source_url: z.string(),
  source_host: z.string(),
  read_minutes: z.number().optional(),
  category: z.string().optional(),
  tags: z.array(z.object({ slug: z.string(), name_zh: z.string(), name_en: z.string() })).optional(),
  sections: z.array(SectionSchema).optional(),
});
export type Pick = z.infer<typeof PickSchema>;

export async function getPick(config: Config, slug: string): Promise<Pick> {
  const data = await getJson(config, `/api/picks/${encodeURIComponent(slug)}`);
  return validate(PickSchema, data, "pick");
}

// --- wiki -------------------------------------------------------------------

const WikiTopicSchema = z.object({
  title_zh: z.string(),
  title_en: z.string(),
  blurb_zh: z.string(),
  blurb_en: z.string(),
  pick_slugs: z.array(z.string()),
});
const WikiSchema = z.object({
  intro_zh: z.string(),
  intro_en: z.string(),
  topics: z.array(WikiTopicSchema),
  picks_count: z.number().optional(),
  model: z.string().nullable().optional(),
  generated_at: z.union([z.string(), z.null()]).optional(),
});
export type Wiki = z.infer<typeof WikiSchema>;
export type WikiTopic = z.infer<typeof WikiTopicSchema>;

/** The live wiki index, or null when none has been built yet. */
export async function getWiki(config: Config): Promise<Wiki | null> {
  const data = await getJson(config, `/api/wiki`);
  if (data && typeof data === "object" && "empty" in data) return null;
  return validate(WikiSchema, data, "wiki");
}
