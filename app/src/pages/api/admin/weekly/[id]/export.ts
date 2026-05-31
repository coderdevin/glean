import type { APIRoute } from "astro";
import { db } from "~/db/client";
import { weeklyById, picksForWeekly } from "~/lib/queries";
import { buildWeeklyGroups, type LayoutSection } from "~/lib/weekly";
import {
  renderWeeklyExportHtml,
  exportFilename,
  type ExportGroup,
  type Lang,
} from "~/lib/weekly-export";

export const prerender = false;

/**
 * Export one weekly issue as a single self-contained HTML file.
 *
 *   GET .../export?lang=zh|en           → downloads glean-weekly-NNN-<lang>.html
 *   GET .../export?lang=zh|en&inline=1  → a preview page (iframe + toolbar:
 *                                          Print/PDF, Download, Copy-HTML)
 *
 * The artifact itself never contains the preview toolbar: the preview page
 * embeds the clean HTML in an iframe so "select all → copy" and the download
 * both yield exactly the email-safe document. Unpublished issues are allowed —
 * an editor may want the file before sending.
 */
export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const drizzleDb = db(env.DB);
  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });

  const url = new URL(ctx.request.url);
  const lang: Lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
  const inline = url.searchParams.get("inline") === "1";

  const picks = await picksForWeekly(drizzleDb, id);
  const layout: LayoutSection[] = issue.layoutJson
    ? JSON.parse(issue.layoutJson)
    : [];
  const groups = buildWeeklyGroups(layout, picks);
  const exportGroups: ExportGroup[] = groups.map((g) => ({
    zh: g.zh,
    en: g.en,
    picks: g.picks.map((p) => ({
      title_zh: p.title_zh,
      title_en: p.title_en,
      summary_zh: p.summary_zh,
      summary_en: p.summary_en,
      slug: p.slug,
      source_host: p.source_host,
      read_minutes: p.read_minutes,
      editor_note_zh: p.editor_note_zh,
      editor_note_en: p.editor_note_en,
    })),
  }));

  const html = renderWeeklyExportHtml({
    lang,
    siteName: env.SITE_NAME || "Glean",
    siteUrl: (env.SITE_URL || "").replace(/\/$/, ""),
    issue: {
      number: issue.number,
      titleZh: issue.titleZh,
      titleEn: issue.titleEn,
      introZh: issue.introZh,
      introEn: issue.introEn,
      dateStart: issue.dateStart,
      dateEnd: issue.dateEnd,
    },
    groups: exportGroups,
  });

  const filename = exportFilename(issue.number, lang);

  if (!inline) {
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return new Response(previewPage(html, filename, lang, id, issue.number), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

/**
 * The preview shell. Keeps the clean export HTML pristine inside an iframe so
 * neither the toolbar nor its scripts ever leak into a copy/download. All
 * actions run client-side off the same embedded string.
 */
function previewPage(
  cleanHtml: string,
  filename: string,
  lang: Lang,
  id: string,
  number: number,
): string {
  const no = String(number).padStart(3, "0");
  const otherLang: Lang = lang === "zh" ? "en" : "zh";
  // Embed safely: JSON-encode, then neutralize any "</script" so the literal
  // can't terminate the inline <script> early.
  const payload = JSON.stringify(cleanHtml).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>导出预览 · Weekly #${no}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #ece7df; color: #2b2722; }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; background: #fff; border-bottom: 1px solid #e7e1d8; }
  .bar h1 { font-size: 14px; margin: 0 12px 0 0; font-weight: 600; }
  .bar .lang { font-size: 12px; color: #6b6357; margin-right: auto; }
  .bar a.lang-link { color: #b1543a; text-decoration: none; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 8px; border: 1px solid #d9d2c7; background: #faf8f4; color: #2b2722; cursor: pointer; }
  button.primary { background: #b1543a; border-color: #b1543a; color: #fff; }
  button:active { transform: translateY(1px); }
  .hint { width: 100%; font-size: 12px; color: #6b6357; margin: 0; }
  #ok { color: #2f7d4f; font-weight: 600; font-size: 13px; }
  .frame-wrap { padding: 20px 16px 48px; display: flex; justify-content: center; }
  iframe { width: 100%; max-width: 680px; height: 80vh; border: 1px solid #e7e1d8; border-radius: 12px; background: #fff; box-shadow: 0 2px 24px rgba(0,0,0,.06); }
  @media print { .bar, .frame-wrap { padding: 0; } iframe { box-shadow: none; border: 0; border-radius: 0; max-width: 100%; height: auto; } .bar { display: none; } }
</style>
</head>
<body>
<div class="bar">
  <h1>周刊 #${no} · 导出</h1>
  <span class="lang">语言 · ${lang === "zh" ? "中文" : "English"} · <a class="lang-link" href="/api/admin/weekly/${id}/export?lang=${otherLang}&inline=1">切换 ${otherLang === "zh" ? "中文" : "EN"}</a></span>
  <button class="primary" id="print">打印 / 存为 PDF</button>
  <button id="copy">复制为邮件 HTML</button>
  <button id="download">下载 .html 文件</button>
  <span id="ok" hidden>✓ 已复制</span>
  <p class="hint">「复制为邮件 HTML」后，直接在 Outlook / Mac 邮件 / Gmail 的写信窗口里粘贴即可。打印时在浏览器里选「另存为 PDF」。</p>
</div>
<div class="frame-wrap">
  <iframe id="frame" title="weekly export preview"></iframe>
</div>
<script>
  const HTML = ${payload};
  const FILENAME = ${JSON.stringify(filename)};
  const frame = document.getElementById("frame");
  frame.srcdoc = HTML;

  document.getElementById("print").addEventListener("click", () => {
    const w = frame.contentWindow;
    if (w) { w.focus(); w.print(); } else { window.print(); }
  });

  document.getElementById("download").addEventListener("click", () => {
    const blob = new Blob([HTML], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = FILENAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  document.getElementById("copy").addEventListener("click", async () => {
    const ok = document.getElementById("ok");
    try {
      const item = new ClipboardItem({
        "text/html": new Blob([HTML], { type: "text/html" }),
        "text/plain": new Blob([HTML], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
    } catch (e) {
      // Fallback: select the rendered iframe body and execCommand copy.
      try {
        const doc = frame.contentDocument;
        const sel = window.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(doc.body);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("copy");
        sel.removeAllRanges();
      } catch (e2) {
        alert("自动复制失败，请在预览区手动全选复制。");
        return;
      }
    }
    ok.hidden = false;
    setTimeout(() => { ok.hidden = true; }, 2000);
  });
</script>
</body>
</html>`;
}
