import type { SubmissionStatus } from "~/db/schema";

export type FailureStage = "extract" | "analysis" | "sections";

/** Tone drives the pill color class (status-<tone>) in styles.css. */
export type StatusTone = "muted" | "amber" | "amber2" | "teal" | "green" | "neutral" | "red";

export const STATUS_META: Record<SubmissionStatus, { zh: string; en: string; tone: StatusTone }> = {
  pending:   { zh: "排队中",     en: "Queued",    tone: "muted" },
  analyzing: { zh: "AI 解析中",  en: "Analyzing", tone: "amber" },
  composing: { zh: "生成正文中", en: "Composing", tone: "amber2" },
  ready:     { zh: "待处理",     en: "Ready",     tone: "teal" },
  published: { zh: "已发布",     en: "Published", tone: "green" },
  rejected:  { zh: "已否",       en: "Rejected",  tone: "neutral" },
  failed:    { zh: "处理失败",   en: "Failed",    tone: "red" },
};

const IN_FLIGHT: ReadonlySet<SubmissionStatus> = new Set(["pending", "analyzing", "composing"]);

export function isInFlight(status: SubmissionStatus): boolean {
  return IN_FLIGHT.has(status);
}
export function isReady(status: SubmissionStatus): boolean {
  return status === "ready";
}

/** Sections with text on at least one side. Truncated/all-blank don't count. */
export function countValidSections(sectionsJson: string | null | undefined): number {
  if (!sectionsJson) return 0;
  try {
    const v = JSON.parse(sectionsJson);
    if (!Array.isArray(v)) return 0;
    return v.filter((s) => {
      const zh = typeof s?.body_zh === "string" ? s.body_zh.trim().length : 0;
      const en = typeof s?.body_en === "string" ? s.body_en.trim().length : 0;
      return zh > 0 || en > 0;
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Map a pre-redesign row onto the new single axis. Pure so the SQL migration's
 * intent is unit-tested here even though the migration itself is hand-written
 * SQL. `sectionsCount` = countValidSections(ai_sections_json).
 */
export function mapLegacyStatus(
  oldStatus: string,
  oldSectionsStatus: string | null,
  rejectReason: string | null,
  sectionsCount: number,
): { status: SubmissionStatus; failureStage: FailureStage | null } {
  if (oldStatus === "pending") return { status: "pending", failureStage: null };
  if (oldStatus === "published") return { status: "published", failureStage: null };
  if (oldStatus === "processing") return { status: "analyzing", failureStage: null };

  if (oldStatus === "rejected") {
    if (rejectReason?.startsWith("extract:")) return { status: "failed", failureStage: "extract" };
    if (rejectReason?.startsWith("llm:")) return { status: "failed", failureStage: "analysis" };
    return { status: "rejected", failureStage: null };
  }

  if (oldStatus === "ready") {
    if (oldSectionsStatus === "ok") return { status: "ready", failureStage: null };
    if (oldSectionsStatus === "pending") return { status: "composing", failureStage: null };
    if (oldSectionsStatus === "failed") return { status: "failed", failureStage: "sections" };
    return sectionsCount > 0
      ? { status: "ready", failureStage: null }
      : { status: "failed", failureStage: "sections" };
  }

  return { status: oldStatus as SubmissionStatus, failureStage: null };
}
