/**
 * Request-body contracts for the reader-notes API, extracted so the exact
 * shapes the client (src/scripts/reading-notes.ts) sends can be unit-tested
 * against what the routes accept. Two silent-400 bugs lived here before this
 * existed: a missing `pickId`, and `note: null` rejected by a non-nullable
 * `.optional()`. See scripts/reader-notes-schema.test.ts.
 */
import { z } from "zod";
import { READER_NOTE_COLORS } from "../db/schema";

export const CreateNoteBody = z.object({
  pickId: z.string().min(1).max(40),
  sectionIndex: z.number().int().min(0).max(10000),
  lang: z.enum(["zh", "en"]),
  // A highlight can be a whole long section, not just a sentence — keep the cap
  // generous so a long selection doesn't silently 400. (exact must match the
  // source text verbatim for re-anchoring, so it can't be truncated.)
  exact: z.string().min(1).max(20000),
  prefix: z.string().max(400).optional(),
  suffix: z.string().max(400).optional(),
  startOffset: z.number().int().min(0).max(2_000_000),
  color: z.enum(READER_NOTE_COLORS).default("yellow"),
  // Client sends note:null for a plain highlight — accept null, not just absent.
  note: z.string().max(4000).nullable().optional(),
});

export const PatchNoteBody = z.object({
  color: z.enum(READER_NOTE_COLORS).optional(),
  note: z.string().max(4000).nullable().optional(),
});
