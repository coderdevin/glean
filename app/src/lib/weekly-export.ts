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
 *      layout — the only thing that survives across mail clients. The body is
 *      FULLY FLUID (width:100%, no inline max-width): mail clients ignore the
 *      `<style>` block, so a max-width there can't make phone Outlook treat the
 *      mail as a fixed-width page and zoom it out. The reading-width cap is a
 *      screen-only media query, so it shapes the browser/PDF view only.
 *
 * The palette echoes the site's warm paper + terracotta accent without any
 * external CSS, so the file renders identically offline and inside an email.
 */

export type Lang = "zh" | "en";

const ACCENT = "#b1543a";
const INK = "#2b2722";
const BODY = "#46403a"; // body copy — darker than MUTED for readable contrast
const MUTED = "#6b6357"; // meta / labels only
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

  // Assign each article a running 1..N number once, so the Contents index and
  // the detail blocks reference the same number (sections keep their own 01/02).
  let running = 0;
  const numberedGroups = groups.map((g) => ({
    zh: g.zh,
    en: g.en,
    picks: g.picks.map((p) => ({ pick: p, n: ++running })),
  }));

  // Contents — a scannable index of section names + numbered article titles,
  // shown BEFORE the full details. Kept as ONE tinted card (its own table so
  // Outlook keeps the bg); it's the only boxed element now the outer card is gone.
  const contentsHtml = `<tr><td style="padding:20px 20px 0 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${RULE};border-radius:10px;background:${PAPER};">
<tr><td style="padding:14px 16px;">
<div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:4px;">${zh ? "目录 · Contents" : "Contents · 目录"}</div>
${numberedGroups
    .map(
      (g, gi) => `<div style="margin-top:10px;">
<div style="font-size:14px;font-weight:700;color:${ACCENT};">${secNo(gi)} · ${esc(zh ? g.zh : g.en)}</div>
${g.picks
        .map(
          ({ pick, n }) =>
            `<div style="font-size:14.5px;line-height:1.7;color:${INK};"><span style="color:${MUTED};font-variant-numeric:tabular-nums;">${n}.</span> ${esc(pickTitle(pick))}</div>`,
        )
        .join("")}
</div>`,
    )
    .join("")}
</td></tr>
</table>
</td></tr>`;

  // Full details, section by section. Section numbers mirror the contents;
  // each article carries its running number as a leading badge.
  const sectionsHtml = numberedGroups
    .map((g, gi) => {
      const heading = zh ? g.zh : g.en;
      const items = g.picks
        .map(({ pick: p, n }) => {
          const pSummary = zh ? p.summary_zh : p.summary_en;
          const note = zh ? p.editor_note_zh : p.editor_note_en;
          const meta = `${esc(p.source_host)} · ${p.read_minutes} min`;
          const noteHtml = note
            ? `<p style="margin:9px 0 0 0;font-size:13.5px;line-height:1.65;color:${ACCENT};"><span style="font-weight:600;">${zh ? "编辑" : "Editor"}</span> ${esc(note)}</p>`
            : "";
          // Each pick is its own block so print can keep it whole (break-inside).
          // The running number leads the title (accent-colored), meta sits above.
          return `<div class="pick" style="padding:16px 0;border-bottom:1px solid ${RULE};">
<div style="font-size:13px;color:${MUTED};margin-bottom:4px;">${meta}</div>
<a href="${base}/a/${esc(p.slug)}" style="font-size:18px;font-weight:600;color:${INK};text-decoration:none;line-height:1.45;"><span style="color:${MUTED};font-weight:500;">${n}.</span> ${esc(pickTitle(p))}</a>
<p style="margin:7px 0 0 0;font-size:15.5px;line-height:1.75;color:${BODY};">${esc(pSummary)}</p>
${noteHtml}
</div>`;
        })
        .join("");
      // Number + heading share ONE tinted block (a section banner with a left
      // accent rule). A single bg cell — number and title sit on the same color
      // block, and there's no inline-block for Outlook to break onto two lines.
      return `<tr><td class="sec" style="padding:26px 20px 0 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:10px;"><tr>
<td style="background:${PAPER};border-left:4px solid ${ACCENT};padding:11px 16px;line-height:1.35;"><span style="font-size:15px;font-weight:700;color:${ACCENT};">${secNo(gi)}</span><span style="color:${MUTED};">&nbsp;·&nbsp;</span><span style="font-size:19px;font-weight:700;color:${ACCENT};">${esc(heading)}</span></td>
</tr></table>
${items}
</td></tr>`;
    })
    .join("");

  const readOnWeb = zh
    ? "在网页上阅读本期每篇内容详情 →"
    : "Read every article in full on the web →";
  const eyebrow = `${esc(siteName)} · ${zh ? "第" : "Issue"} ${no} ${zh ? "期" : ""} · ${esc(issue.dateStart)} → ${esc(issue.dateEnd)}`;

  // Canonical web URLs (used by the read-on-web CTA).
  const zhUrl = `${base}/weekly/${issue.number}`;
  const enUrl = `${base}/en/weekly/${issue.number}`;

  // <style> is for browser screen + print only; mail clients drop it, so it can
  // never override the inline styles that email rendering relies on.
  const styleBlock = `<style>
  @page { margin: 14mm; }
  body { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  a { text-decoration: none; }
  /* The email body is fully fluid (width:100%, NO inline max-width) so phone
     mail clients render it at device width instead of treating a max-width as a
     fixed px width and zooming the whole thing out. The reading-width cap is
     applied ONLY for browser screens (preview + "save as PDF") and is ignored
     by mail clients, so it can't trigger mobile zoom-to-fit. */
  @media screen and (min-width: 720px) {
    .sheet { max-width: 760px !important; margin: 0 auto !important; }
  }
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
<body style="margin:0;padding:0;background:${CARD};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${CARD};opacity:0;">${esc(intro.slice(0, 110))}</div>
<table role="presentation" class="wrap" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CARD};">
<tr><td align="center" style="padding:8px 0 22px;">
<table role="presentation" class="sheet" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${CARD};">
<tr><td style="padding:28px 20px 0 20px;">
<div style="height:3px;width:44px;background:${ACCENT};border-radius:2px;margin-bottom:14px;font-size:0;line-height:3px;">&nbsp;</div>
<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${eyebrow}</div>
<h1 style="margin:8px 0 12px 0;font-size:26px;line-height:1.25;color:${INK};">${esc(title)}</h1>
<p style="margin:0;font-size:16px;line-height:1.8;color:${BODY};">${esc(intro)}</p>
</td></tr>
${contentsHtml}
${sectionsHtml}
<tr><td class="web-cta" style="padding:26px 20px 32px 20px;">
<a href="${zh ? zhUrl : enUrl}" style="display:inline-block;padding:12px 26px;border-radius:8px;background:${ACCENT};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${readOnWeb}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
