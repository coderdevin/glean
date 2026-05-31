import assert from "node:assert/strict";
import {
  renderWeeklyEmailFragment,
  renderWeeklyExportHtml,
  exportFilename,
  type ExportGroup,
  type ExportIssueMeta,
} from "../src/lib/weekly-export";

const issue: ExportIssueMeta = {
  number: 7,
  titleZh: "本期标题",
  titleEn: "This Week",
  introZh: "导语中文",
  introEn: "Intro english",
  dateStart: "2026-05-18",
  dateEnd: "2026-05-24",
};

const groups: ExportGroup[] = [
  {
    zh: "推理",
    en: "Inference",
    picks: [
      {
        title_zh: "标题<x>", // HTML-significant chars to test escaping
        title_en: "Title & more",
        summary_zh: "摘要",
        summary_en: "summary",
        slug: "my-article",
        source_host: "example.com",
        read_minutes: 6,
        editor_note_zh: "编辑点评<b>",
        editor_note_en: null,
      },
    ],
  },
  {
    zh: "其他",
    en: "More",
    picks: [
      {
        title_zh: "第二篇",
        title_en: "Second",
        summary_zh: "摘要二",
        summary_en: "summary two",
        slug: "second-one",
        source_host: "site.dev",
        read_minutes: 3,
        editor_note_zh: null,
        editor_note_en: null,
      },
    ],
  },
];

const args = {
  siteName: "Glean",
  siteUrl: "https://glean.smartcoder.ai/",
  issue,
  groups,
};

// --- zh render ------------------------------------------------------------
const zh = renderWeeklyExportHtml({ lang: "zh", ...args });
const zhFragment = renderWeeklyEmailFragment({ lang: "zh", ...args });

assert.ok(zh.startsWith("<!doctype html>"), "is a full HTML document");
assert.ok(/<html lang="zh-CN">/.test(zh), "zh sets lang=zh-CN");
assert.ok(zh.includes("本期标题"), "zh title present");
assert.ok(zh.includes("导语中文"), "zh intro present");
assert.ok(
  zh.includes("推理") && zh.includes("其他"),
  "both section headings present (zh)",
);
assert.ok(zh.includes("第二篇"), "second pick present");

// Self-contained: no external CSS/JS, no remote scripts.
assert.ok(!/<link\b/i.test(zh), "no <link> (no external stylesheet)");
assert.ok(!/<script\b/i.test(zh), "no <script> in the artifact");
assert.ok(!/\ssrc=/i.test(zh), "no external src= references");

// Email-safe: inline styles present; copied body avoids table wrappers that can
// make phone clients zoom a pasted desktop-width page down.
assert.ok(zh.includes('style="'), "uses inline styles");

// The clipboard payload must be a body fragment, not a full desktop HTML
// document. Mobile mail clients often zoom out full pasted documents or
// width-capped wrappers.
assert.ok(!zhFragment.includes("<!doctype"), "copy fragment has no doctype");
assert.ok(!/<html\b|<head\b|<body\b/i.test(zhFragment), "copy fragment has no document shell");
assert.ok(!/max-width\s*:\s*\d+px/i.test(zhFragment), "copy fragment has no inline width cap");
assert.ok(!/\bwidth=["']?100%["']?/i.test(zhFragment), "copy fragment avoids width=100% tables");
assert.ok(zhFragment.includes("本期标题"), "copy fragment contains issue content");

// Outlook / Apple Mail hardening.
assert.ok(
  zh.includes("x-apple-disable-message-reformatting"),
  "apple mail meta present",
);
assert.ok(zh.includes("[if mso]"), "MSO conditional (Outlook font fallback) present");
// Browser/PDF preview gets a comfortable reading cap via CSS only; the copied
// email fragment intentionally has no inline width cap.
assert.ok(/\.glean-sheet\s*\{\s*max-width:\s*760px/i.test(zh), "browser preview capped at 760px");

// Print support for browser PDF.
assert.ok(zh.includes("@media print"), "print stylesheet present");
assert.ok(zh.includes("@page"), "print @page margins present");

// Escaping: dangerous chars are encoded, raw tags absent.
assert.ok(zh.includes("标题&lt;x&gt;"), "title is HTML-escaped");
assert.ok(zh.includes("编辑点评&lt;b&gt;"), "editor note is HTML-escaped");
assert.ok(!zh.includes("标题<x>"), "raw unescaped title not present");

// Contents block lists section names + article titles before the details.
assert.ok(/目录|Contents/.test(zh), "contents heading present");
// "推理" and the title appear at least twice each (contents + detail).
assert.ok(zh.split("推理").length - 1 >= 2, "section name appears in contents and detail");
assert.ok(zh.split("第二篇").length - 1 >= 2, "article title appears in contents and detail");
// Section numbering.
assert.ok(zh.includes("01") && zh.includes("02"), "sections are numbered");
// Running article numbers 1..N (2 picks here → 1. 2.), shown in contents + detail.
assert.ok(zh.includes("1.") && zh.includes("2."), "articles carry running numbers");
assert.ok(zh.split("2.").length - 1 >= 2, "article number appears in contents and detail");
// Print-note line removed.
assert.ok(!/另存为 PDF|save it as a PDF/.test(zh), "print-note line removed");

// Links point at the site, no per-recipient/unsubscribe token.
assert.ok(
  zh.includes("https://glean.smartcoder.ai/a/my-article"),
  "article link uses site base",
);
// zh doc's read-on-web CTA points at the zh canonical URL.
assert.ok(
  zh.includes("https://glean.smartcoder.ai/weekly/7"),
  "zh canonical link present",
);
assert.ok(!/unsubscribe/i.test(zh), "no unsubscribe link in a generic export");

// --- en render ------------------------------------------------------------
const en = renderWeeklyExportHtml({ lang: "en", ...args });
assert.ok(/<html lang="en">/.test(en), "en sets lang=en");
assert.ok(en.includes("This Week"), "en title present");
assert.ok(
  en.includes("Inference") && en.includes("More"),
  "en section headings present",
);
assert.ok(en.includes("Title &amp; more"), "en title escaped");
assert.ok(en.includes("Read every article in full on the web"), "en read-on-web CTA");
assert.ok(/Contents/.test(en), "en contents heading present");
assert.ok(en.includes("https://glean.smartcoder.ai/en/weekly/7"), "en canonical link present");
// zh-only editor note must NOT appear in the en render (note_en was null).
assert.ok(!en.includes("编辑点评"), "zh editor note absent from en render");

// --- filename -------------------------------------------------------------
assert.equal(exportFilename(7, "zh"), "glean-weekly-007-zh.html");
assert.equal(exportFilename(123, "en"), "glean-weekly-123-en.html");

console.log("weekly-export.test.ts ✓");
