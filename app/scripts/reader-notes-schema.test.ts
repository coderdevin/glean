import assert from "node:assert/strict";
import { CreateNoteBody, PatchNoteBody } from "../src/lib/reader-notes-schema";

// The EXACT body src/scripts/reading-notes.ts createNote() sends for a plain
// highlight — note:null, with pickId merged in. Both fields broke this before:
// missing pickId, and note:null rejected by a non-nullable .optional().
const clientHighlight = {
  pickId: "01HX0000EXAMPLEULIDxxxxxxxx",
  sectionIndex: 2,
  lang: "en",
  exact: "Using a workflow, go through my last 50 sessions",
  prefix: "rules\n",
  suffix: " and mine",
  startOffset: 142,
  color: "yellow",
  note: null,
};

// plain highlight (note:null) must validate
{
  const r = CreateNoteBody.safeParse(clientHighlight);
  assert.ok(r.success, "plain-highlight payload (note:null, pickId present) must validate");
}

// highlight + annotation must validate
{
  const r = CreateNoteBody.safeParse({ ...clientHighlight, note: "the key idea" });
  assert.ok(r.success, "annotated payload must validate");
}

// regression: a missing pickId must be rejected (was silently 400ing → no paint)
{
  const { pickId, ...noPick } = clientHighlight;
  void pickId;
  assert.ok(!CreateNoteBody.safeParse(noPick).success, "missing pickId must be rejected");
}

// color defaults to yellow when absent
{
  const { color, ...noColor } = clientHighlight;
  void color;
  const r = CreateNoteBody.safeParse(noColor);
  assert.ok(r.success && r.data.color === "yellow", "color defaults to yellow");
}

// bad lang / oversized exact rejected
assert.ok(!CreateNoteBody.safeParse({ ...clientHighlight, lang: "fr" }).success, "bad lang rejected");
assert.ok(CreateNoteBody.safeParse({ ...clientHighlight, exact: "x".repeat(20000) }).success, "a long (whole-section) selection is accepted");
assert.ok(!CreateNoteBody.safeParse({ ...clientHighlight, exact: "x".repeat(20001) }).success, "exact over the cap rejected");
assert.ok(!CreateNoteBody.safeParse({ ...clientHighlight, exact: "" }).success, "empty exact rejected");

// numeric bounds — locked so a future extraction can't silently drop .int()/max
assert.ok(!CreateNoteBody.safeParse({ ...clientHighlight, sectionIndex: 1.5 }).success, "non-integer sectionIndex rejected");
assert.ok(!CreateNoteBody.safeParse({ ...clientHighlight, startOffset: -1 }).success, "negative startOffset rejected");
assert.ok(!CreateNoteBody.safeParse({ ...clientHighlight, startOffset: 2_000_001 }).success, "startOffset over the cap rejected");

// PATCH: note:null (clearing an annotation) and color-only both validate
assert.ok(PatchNoteBody.safeParse({ note: null }).success, "patch note:null must validate");
assert.ok(PatchNoteBody.safeParse({ color: "pink" }).success, "patch color-only must validate");

console.log("reader-notes-schema contract assertions passed");
