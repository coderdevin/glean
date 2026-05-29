import { z } from "zod";

const Form = z.object({
  title_zh: z.string().max(200).default(""),
  title_en: z.string().max(200).default(""),
  summary_zh: z.string().max(1000).default(""),
  summary_en: z.string().max(1000).default(""),
  bullets_zh: z.string().max(4000).default(""),
  bullets_en: z.string().max(4000).default(""),
  editor_zh: z.string().max(400).default(""),
  editor_en: z.string().max(400).default(""),
  tags: z.string().max(200).default(""),
  category: z.enum(["infra", "data", "code"]).default("code"),
  score: z.coerce.number().min(0).max(1).default(0.5),
  submitter: z.string().max(40).default(""),
  reject_reason: z.string().max(200).optional(),
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
