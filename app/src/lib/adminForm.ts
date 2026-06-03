import { z } from "zod";
import { normalizeCategorySlug } from "./category";

// Editor input is TRUSTED (admin-only) and free-form. A hard cap that *rejects*
// makes readAdminForm throw → the route returns a bare HTTP 500 (this is exactly
// how the category enum, then the summary/bullets length caps, each surfaced as
// "publish 500s again"). So bound by *truncation*, not rejection: clip overly
// long values to a generous limit instead of failing the whole form. Limits are
// sized well above real bilingual content; the columns are plain D1 TEXT.
const clip = (max: number) =>
  z
    .string()
    .default("")
    .transform((s) => s.slice(0, max));

const Form = z.object({
  title_zh: clip(300),
  title_en: clip(300),
  summary_zh: clip(8000),
  summary_en: clip(8000),
  bullets_zh: clip(20000),
  bullets_en: clip(20000),
  editor_zh: clip(8000),
  editor_en: clip(8000),
  tags: clip(1000),
  // Free-form category slug (self-growing taxonomy), NOT the old infra/data/code
  // enum — the editor's combobox sends any AI-proposed slug. Normalize to a kebab
  // slug; empty → "code".
  category: z
    .string()
    .default("code")
    .transform((s) => normalizeCategorySlug(s) || "code"),
  // Empty / malformed / out-of-range score falls back to 0.5 — never throws.
  score: z.preprocess(
    (v) => (v === "" || v == null ? 0.5 : v),
    z.coerce.number().min(0).max(1).catch(0.5),
  ),
  submitter: clip(80),
  reject_reason: z
    .string()
    .optional()
    .transform((s) => (typeof s === "string" ? s.slice(0, 1000) : s)),
});

export type AdminFormInput = z.infer<typeof Form>;

export async function readAdminForm(request: Request): Promise<AdminFormInput> {
  const fd = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of fd.entries()) raw[k] = typeof v === "string" ? v : "";
  const parsed = Form.safeParse(raw);
  if (!parsed.success) {
    throw new Error("invalid admin form: " + parsed.error.message);
  }
  return parsed.data;
}

export function parseBulletLines(zhText: string, enText: string): { zh: string; en: string }[] {
  const zhLines = zhText.split("\n").map(stripBullet).filter(Boolean);
  const enLines = enText.split("\n").map(stripBullet).filter(Boolean);
  const len = Math.max(zhLines.length, enLines.length);
  const out: { zh: string; en: string }[] = [];
  for (let i = 0; i < len; i++) {
    out.push({ zh: zhLines[i] ?? "", en: enLines[i] ?? "" });
  }
  return out;
}

function stripBullet(s: string): string {
  return s.replace(/^[-*•]\s+/, "").trim();
}

export function parseTags(s: string): string[] {
  return s
    .split(/[,，]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}
