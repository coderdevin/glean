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

/** The submit/success view model. Shared by the SSR page render and the
 *  /api/submit/status polling endpoint so both always agree on copy + step. */
export interface SuccessView {
  status: SubmissionStatus;
  /** 1–4 along the progress strip; -1 for rejected (no active step). */
  stepIndex: number;
  /** No more polling needed once published or rejected. */
  isTerminal: boolean;
  headline: { zh: string; en: string };
  sub: { zh: string; en: string };
  /** Show the “see today’s daily” CTA (published with a linked pick). */
  hasPick: boolean;
}

export function successView(row: {
  status: SubmissionStatus;
  rejectReason: string | null;
  linkedPickId: string | null;
}): SuccessView {
  const { status, rejectReason, linkedPickId } = row;
  const stepIndex = (() => {
    switch (status) {
      case "pending":   return 1;
      case "analyzing": return 2;
      case "composing": return 2;
      case "failed":    return 2; // AI hiccup — editor retries; keep polling
      case "ready":     return 3;
      case "published": return 4;
      case "rejected":  return -1;
      default:          return 1;
    }
  })();
  const headline =
    status === "published" ? { zh: "已发布 · 看一眼", en: "Published — go read it" }
    : status === "rejected" ? { zh: "未通过 · 改天再战", en: "Didn’t make it — try another" }
    : { zh: "收到了，谢谢。", en: "Got it — thanks." };
  const sub =
    status === "published" ? { zh: "通过 · 已上日刊。", en: "Approved · live on today’s daily." }
    : status === "rejected" ? { zh: rejectReason ?? "未通过 · 谢谢支持。", en: rejectReason ?? "Not selected — thanks for trying." }
    : { zh: "已入队 · 编辑通常 1 小时内读一眼。", en: "In the queue · usually read within an hour." };
  return {
    status,
    stepIndex,
    isTerminal: status === "published" || status === "rejected",
    headline,
    sub,
    hasPick: status === "published" && !!linkedPickId,
  };
}

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
