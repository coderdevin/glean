import type { SubmissionStatus } from "~/db/schema";

export type ProcessingStage = "extract" | "llm";

export interface AdminProcessingStatusInput {
  status: SubmissionStatus;
  rawR2Key: string | null;
  processingStartedAt: Date | null;
  processingModel: string | null;
  createdAt: Date | null;
  rawTotalChars: number | null;
  now?: Date;
}

export interface AdminProcessingStatus {
  stage: ProcessingStage;
  title: string;
  detail: string;
  modelLabel: string | null;
  elapsedMin: number;
  elapsedLabel: string;
  windowLabel: string;
  progressPct: number;
  isPastWindow: boolean;
  steps: Array<{ label: string; state: "done" | "active" | "pending" }>;
}

const EXTRACT_MAX_MS = 2 * 60_000;
const LLM_MAX_MS = 12 * 60_000;

export function getAdminProcessingStatus(input: AdminProcessingStatusInput): AdminProcessingStatus {
  const stage: ProcessingStage = input.status === "composing" || input.rawR2Key ? "llm" : "extract";
  const now = input.now ?? new Date();
  const startedAt = input.processingStartedAt ?? input.createdAt ?? now;
  const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
  const elapsedMin = Math.max(0, Math.floor(elapsedMs / 60_000));
  const maxMs = stage === "extract" ? EXTRACT_MAX_MS : LLM_MAX_MS;
  const progressPct = Math.max(5, Math.min(100, Math.round((elapsedMs / maxMs) * 100)));
  const modelLabel = stage === "llm" ? modelShortLabel(input.processingModel) : null;
  const rawLabel = input.rawTotalChars == null ? "the extracted source" : `${input.rawTotalChars.toLocaleString()} chars`;

  if (input.status === "composing") {
    return {
      stage: "llm",
      title: "Composing sections",
      detail: "Splitting the article into bilingual sections. This page refreshes every 4s.",
      modelLabel,
      elapsedMin,
      elapsedLabel: elapsedMin ? `${elapsedMin}min` : "<1min",
      windowLabel: "typical 2-4min · max 12min",
      progressPct,
      isPastWindow: elapsedMs > LLM_MAX_MS,
      steps: [
        { label: "Draft fields saved", state: "done" },
        { label: "Body sections", state: "active" },
        { label: "Ready for review", state: "pending" },
      ],
    };
  }

  if (stage === "extract") {
    return {
      stage,
      title: "Fetching source",
      detail: "Fetching the URL, extracting readable text, and saving the raw body to R2.",
      modelLabel,
      elapsedMin,
      elapsedLabel: elapsedMin ? `${elapsedMin}min` : "<1min",
      windowLabel: "usually <2min",
      progressPct,
      isPastWindow: elapsedMs > EXTRACT_MAX_MS,
      steps: [
        { label: "Source fetch", state: "active" },
        { label: "Raw text saved", state: "pending" },
        { label: "AI analysis", state: "pending" },
      ],
    };
  }

  return {
    stage,
    title: "DeepSeek analysis",
    detail: `Analyzing ${rawLabel} with DeepSeek ${modelLabel ?? "V4-Pro"}. This page refreshes every 4s.`,
    modelLabel,
    elapsedMin,
    elapsedLabel: elapsedMin ? `${elapsedMin}min` : "<1min",
    windowLabel: "typical 2-4min · max 12min",
    progressPct,
    isPastWindow: elapsedMs > LLM_MAX_MS,
    steps: [
      { label: "Source extracted", state: "done" },
      { label: `${modelLabel ?? "V4-Pro"} running`, state: "active" },
      { label: "Draft fields saved", state: "pending" },
    ],
  };
}

function modelShortLabel(model: string | null): string {
  if (!model) return "V4-Pro";
  const lower = model.toLowerCase();
  if (lower.includes("flash")) return "V4-Flash";
  if (lower.includes("v4-pro")) return "V4-Pro";
  return model.replace(/^deepseek[-/]/i, "");
}
