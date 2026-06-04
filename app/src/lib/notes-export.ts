/**
 * Pure Markdown builder for the "my notes" export. No DOM, no I/O; unit-tested
 * via scripts/notes-export.test.ts. Each article becomes a section with its
 * highlights as blockquotes and annotations as the following paragraph.
 */

export interface ExportNote {
  exact: string;
  note?: string | null;
}

export interface ExportGroup {
  title: string;
  url: string;
  notes: ExportNote[];
}

/** Collapse newlines so a multi-line quote stays inside one blockquote line. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

export function notesToMarkdown(groups: ExportGroup[], heading = "我的笔记"): string {
  const out: string[] = [`# ${heading}`, ""];
  for (const g of groups) {
    out.push(`## ${oneLine(g.title)}`);
    out.push(g.url);
    out.push("");
    for (const n of g.notes) {
      const quote = oneLine(n.exact);
      if (!quote) continue; // skip a highlight whose quote collapsed to empty
      out.push(`> ${quote}`);
      const note = (n.note ?? "").trim();
      if (note) {
        out.push("");
        out.push(oneLine(note));
      }
      out.push("");
    }
  }
  // Trim a single trailing blank line for a tidy file.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}
