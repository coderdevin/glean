/**
 * Standalone weekly-issue export. Pure — no I/O, no env: takes plain issue data
 * and returns one self-contained HTML document (the "artifact"). Unit-tested via
 * scripts/weekly-export.test.ts.
 *
 * Two consumers, one output:
 *   1. Browser → "Print / Save as PDF". The `<style>` block carries `@page` +
 *      `@media print` rules for tidy pagination (white background, no clipped
 *      cards). Email clients ignore <style>, so it can't hurt them.
 *   2. Copy-paste into an email compose window (Outlook / Apple Mail / Gmail).
 *      EVERY visible element is styled INLINE with a single-column <table>
 *      layout — the only thing that survives across mail clients. The doc adds
 *      an MSO "ghost table" so Outlook (Word engine, no max-width) keeps the
 *      600px column, and the Apple-Mail "disable reformatting" meta.
 *
 * The palette echoes the site's warm paper + terracotta accent without any
 * external CSS, so the file renders identically offline and inside an email.
 */

export type Lang = "zh" | "en";

const ACCENT = "#b1543a";
const INK = "#2b2722";
const MUTED = "#6b6357";
const PAPER = "#faf8f4";
const CARD = "#ffffff";
const RULE = "#e7e1d8";

/** Escape content for safe interpolation into HTML text/attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ExportPick {
  title_zh: string;
  title_en: string;
  summary_zh: string;
  summary_en: string;
  slug: string;
  source_host: string;
  read_minutes: number;
  editor_note_zh?: string | null;
  editor_note_en?: string | null;
}

export interface ExportGroup {
  zh: string;
  en: string;
  picks: ExportPick[];
}

export interface ExportIssueMeta {
  number: number;
  titleZh: string;
  titleEn: string;
  introZh: string;
  introEn: string;
  dateStart: string;
  dateEnd: string;
}

/** A safe, descriptive download filename for an issue in a given language. */
export function exportFilename(number: number, lang: Lang): string {
  return `glean-weekly-${String(number).padStart(3, "0")}-${lang}.html`;
}

/**
 * Render one weekly issue as a self-contained HTML document in a single
 * language. No unsubscribe/recipient tokens — this is a generic, shareable
 * artifact, not a per-recipient send.
 */
export function renderWeeklyExportHtml(args: {
  lang: Lang;
  siteName: string;
  siteUrl: string;
  issue: ExportIssueMeta;
  groups: ExportGroup[];
}): string {
  const { lang, siteName, siteUrl, issue, groups } = args;
  const zh = lang === "zh";
  const base = siteUrl.replace(/\/$/, "");
  const no = String(issue.number).padStart(3, "0");

  const title = zh ? issue.titleZh : issue.titleEn;
  const intro = zh ? issue.introZh : issue.introEn;
  const docTitle = `${siteName} ${zh ? "周刊" : "Weekly"} #${no} · ${title}`;
  const langAttr = zh ? "zh-CN" : "en";

  const secNo = (i: number) => String(i + 1).padStart(2, "0");
  const pickTitle = (p: ExportPick) => (zh ? p.title_zh : p.title_en);

  // Contents — a scannable index of section names + article titles, shown
  // BEFORE the full details so a reader (or a printed page-one) sees the shape
  // of the issue at a glance. Boxed in its own table so Outlook keeps the bg.
  const contentsHtml = `<tr><td style="padding:22px 32px 0 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${RULE};border-radius:10px;background:${PAPER};">
<tr><td style="padding:16px 18px;">
<div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:6px;">${zh ? "目录 · Contents" : "Contents · 目录"}</div>
${groups
    .map(
      (g, gi) => `<div style="margin-top:12px;">
<div style="font-size:13px;font-weight:700;color:${ACCENT};">${secNo(gi)} · ${esc(zh ? g.zh : g.en)}</div>
${g.picks
        .map(
          (p) =>
            `<div style="font-size:13.5px;line-height:1.7;color:${INK};padding-left:2px;">· ${esc(pickTitle(p))}</div>`,
        )
        .join("")}
</div>`,
    )
    .join("")}
</td></tr>
</table>
</td></tr>`;

  // Full details, section by section. Section numbers mirror the contents.
  const sectionsHtml = groups
    .map((g, gi) => {
      const heading = zh ? g.zh : g.en;
      const items = g.picks
        .map((p) => {
          const pSummary = zh ? p.summary_zh : p.summary_en;
          const note = zh ? p.editor_note_zh : p.editor_note_en;
          const meta = `${esc(p.source_host)} · ${p.read_minutes} min`;
          const noteHtml = note
            ? `<p style="margin:8px 0 0 0;font-size:13px;line-height:1.6;color:${ACCENT};"><span style="font-weight:600;">${zh ? "编辑" : "Editor"}</span> ${esc(note)}</p>`
            : "";
          // Each pick is its own block so print can keep it whole (break-inside).
          return `<div class="pick" style="padding:16px 0;border-bottom:1px solid ${RULE};">
<div style="font-size:12px;color:${MUTED};margin-bottom:4px;">${meta}</div>
<a href="${base}/a/${esc(p.slug)}" style="font-size:17px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;">${esc(pickTitle(p))}</a>
<p style="margin:6px 0 0 0;font-size:14px;line-height:1.65;color:${MUTED};">${esc(pSummary)}</p>
${noteHtml}
</div>`;
        })
        .join("");
      return `<tr><td class="sec" style="padding:26px 32px 0 32px;">
<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT};font-weight:700;margin-bottom:6px;"><span style="display:inline-block;min-width:22px;padding:2px 7px;margin-right:8px;border-radius:6px;background:${PAPER};color:${ACCENT};border:1px solid ${RULE};letter-spacing:0;">${secNo(gi)}</span>${esc(heading)}</div>
${items}
</td></tr>`;
    })
    .join("");

  const readOnWeb = zh ? "在网页上阅读本期 →" : "Read this issue on the web →";
  const eyebrow = `${esc(siteName)} · ${zh ? "第" : "Issue"} ${no} ${zh ? "期" : ""} · ${esc(issue.dateStart)} → ${esc(issue.dateEnd)}`;

  // Bilingual canonical links, appended at the very end (requested).
  const zhUrl = `${base}/weekly/${issue.number}`;
  const enUrl = `${base}/en/weekly/${issue.number}`;
  const linkLine = (label: string, url: string) =>
    `${label} · <a href="${url}" style="color:${ACCENT};text-decoration:none;">${esc(url.replace(/^https?:\/\//, ""))}</a>`;

  // <style> is for browser screen + print only; mail clients drop it, so it can
  // never override the inline styles that email rendering relies on.
  const styleBlock = `<style>
  @page { margin: 14mm; }
  body { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  a { text-decoration: none; }
  @media print {
    html, body { background: #ffffff !important; }
    .wrap { background: #ffffff !important; padding: 0 !important; }
    .sheet { border: 0 !important; box-shadow: none !important; max-width: 100% !important; }
    .pick { break-inside: avoid; page-break-inside: avoid; }
    .sec { break-inside: avoid-page; }
    .web-cta { display: none !important; }
  }
</style>`;

  return `<!doctype html>
<html lang="${langAttr}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>${esc(docTitle)}</title>
<!--[if mso]><style>table,td,div,p,a{font-family:'Segoe UI',Arial,sans-serif !important;}</style><![endif]-->
${styleBlock}
</head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
<table role="presentation" class="wrap" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};padding:24px 12px;">
<tr><td align="center">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="sheet" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${CARD};border:1px solid ${RULE};border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 32px 0 32px;">
<div style="height:3px;width:44px;background:${ACCENT};border-radius:2px;margin-bottom:14px;"></div>
<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${eyebrow}</div>
<h1 style="margin:8px 0 12px 0;font-size:26px;line-height:1.25;color:${INK};">${esc(title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.75;color:${MUTED};">${esc(intro)}</p>
</td></tr>
${contentsHtml}
${sectionsHtml}
<tr><td class="web-cta" style="padding:26px 32px 8px 32px;">
<a href="${zh ? zhUrl : enUrl}" style="display:inline-block;padding:11px 24px;border-radius:8px;background:${ACCENT};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${readOnWeb}</a>
</td></tr>
<tr><td style="padding:22px 32px 30px 32px;border-top:1px solid ${RULE};color:${MUTED};font-size:12px;line-height:1.8;">
<div style="font-weight:700;color:${INK};font-size:13px;margin-bottom:6px;">${esc(siteName)}</div>
${linkLine(zh ? "中文" : "中文 (Chinese)", zhUrl)}<br>
${linkLine(zh ? "English (英文)" : "English", enUrl)}<br>
<span style="color:${MUTED};">${zh ? "本页可直接打印或另存为 PDF。" : "Print this page or save it as a PDF."}</span>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
