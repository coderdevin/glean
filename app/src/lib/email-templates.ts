/**
 * Pure email body builders. No I/O, no env — take plain data, return
 * { subject, html, text }. Unit-tested via scripts/email-templates.test.ts.
 *
 * Emails use inline styles + a single-column table layout (the only thing that
 * renders consistently across mail clients). The palette echoes the site's
 * warm paper + terracotta accent without depending on the site CSS.
 */

export type Lang = "zh" | "en";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const ACCENT = "#b1543a";
const INK = "#2b2722";
const MUTED = "#6b6357";
const PAPER = "#faf8f4";
const CARD = "#ffffff";
const RULE = "#e7e1d8";

/** Escape user/content text for safe interpolation into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(bodyHtml: string, footerHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${CARD};border:1px solid ${RULE};border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 32px 8px 32px;">
${bodyHtml}
</td></tr>
<tr><td style="padding:24px 32px 32px 32px;border-top:1px solid ${RULE};color:${MUTED};font-size:12px;line-height:1.7;">
${footerHtml}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** Double-opt-in confirmation email. */
export function renderConfirmEmail(args: {
  lang: Lang;
  siteName: string;
  confirmUrl: string;
}): EmailContent {
  const { lang, siteName, confirmUrl } = args;
  const zh = lang === "zh";

  const subject = zh ? `确认订阅 ${siteName} 周刊` : `Confirm your ${siteName} subscription`;
  const heading = zh ? "确认一下就好" : "One quick confirmation";
  const body = zh
    ? "点下面的按钮确认订阅，之后周刊开刊时你会第一时间收到。如果不是你本人操作，忽略这封邮件即可。"
    : "Tap the button to confirm your subscription. You'll get the weekly the moment it launches. If this wasn't you, just ignore this email.";
  const cta = zh ? "确认订阅" : "Confirm subscription";
  const fallback = zh ? "按钮打不开就复制这个链接：" : "If the button doesn't work, paste this link:";

  const html = shell(
    `<h1 style="margin:0 0 16px 0;font-size:24px;color:${INK};">${esc(heading)}</h1>
<p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:${MUTED};">${esc(body)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${ACCENT};">
<a href="${esc(confirmUrl)}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;">${esc(cta)}</a>
</td></tr></table>
<p style="margin:24px 0 0 0;font-size:12px;line-height:1.6;color:${MUTED};">${esc(fallback)}<br><a href="${esc(confirmUrl)}" style="color:${ACCENT};word-break:break-all;">${esc(confirmUrl)}</a></p>`,
    `${esc(siteName)}`,
  );

  const text = `${heading}\n\n${body}\n\n${cta}: ${confirmUrl}`;
  return { subject, html, text };
}

/** Magic-link login email for reader accounts (reading notes). */
export function renderLoginEmail(args: {
  lang: Lang;
  siteName: string;
  loginUrl: string;
}): EmailContent {
  const { lang, siteName, loginUrl } = args;
  const zh = lang === "zh";

  const subject = zh ? `登录 ${siteName}` : `Sign in to ${siteName}`;
  const heading = zh ? "点这里登录" : "Tap to sign in";
  const body = zh
    ? "点下面的按钮即可登录，你的阅读笔记会跟着账号在各设备间同步。链接 15 分钟内有效。如果不是你本人操作，忽略这封邮件即可。"
    : "Tap the button to sign in — your reading notes follow your account across devices. This link expires in 15 minutes. If this wasn't you, just ignore this email.";
  const cta = zh ? "登录" : "Sign in";
  const fallback = zh ? "按钮打不开就复制这个链接：" : "If the button doesn't work, paste this link:";

  const html = shell(
    `<h1 style="margin:0 0 16px 0;font-size:24px;color:${INK};">${esc(heading)}</h1>
<p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:${MUTED};">${esc(body)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${ACCENT};">
<a href="${esc(loginUrl)}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;">${esc(cta)}</a>
</td></tr></table>
<p style="margin:24px 0 0 0;font-size:12px;line-height:1.6;color:${MUTED};">${esc(fallback)}<br><a href="${esc(loginUrl)}" style="color:${ACCENT};word-break:break-all;">${esc(loginUrl)}</a></p>`,
    `${esc(siteName)}`,
  );

  const text = `${heading}\n\n${body}\n\n${cta}: ${loginUrl}`;
  return { subject, html, text };
}

export interface EmailPick {
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

export interface EmailGroup {
  zh: string;
  en: string;
  picks: EmailPick[];
}

export interface WeeklyIssueMeta {
  number: number;
  titleZh: string;
  titleEn: string;
  introZh: string;
  introEn: string;
  dateStart: string;
  dateEnd: string;
}

/** The weekly issue, rendered for one recipient in their preferred language. */
export function renderWeeklyEmail(args: {
  lang: Lang;
  siteName: string;
  siteUrl: string;
  issue: WeeklyIssueMeta;
  groups: EmailGroup[];
  unsubscribeUrl: string;
}): EmailContent {
  const { lang, siteName, siteUrl, issue, groups, unsubscribeUrl } = args;
  const zh = lang === "zh";
  const base = siteUrl.replace(/\/$/, "");
  const no = String(issue.number).padStart(3, "0");

  const title = zh ? issue.titleZh : issue.titleEn;
  const intro = zh ? issue.introZh : issue.introEn;
  const subject = zh ? `${siteName} 周刊 #${no} · ${title}` : `${siteName} Weekly #${no} · ${title}`;

  const sectionsHtml = groups
    .map((g) => {
      const heading = zh ? g.zh : g.en;
      const items = g.picks
        .map((p) => {
          const pTitle = zh ? p.title_zh : p.title_en;
          const pSummary = zh ? p.summary_zh : p.summary_en;
          const note = zh ? p.editor_note_zh : p.editor_note_en;
          const meta = `${esc(p.source_host)} · ${p.read_minutes} min`;
          const noteHtml = note
            ? `<p style="margin:8px 0 0 0;font-size:13px;line-height:1.6;color:${ACCENT};"><span style="font-weight:600;">${zh ? "编辑" : "Editor"}</span> ${esc(note)}</p>`
            : "";
          return `<div style="padding:16px 0;border-bottom:1px solid ${RULE};">
<div style="font-size:12px;color:${MUTED};margin-bottom:4px;">${meta}</div>
<a href="${base}/a/${esc(p.slug)}" style="font-size:17px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;">${esc(pTitle)}</a>
<p style="margin:6px 0 0 0;font-size:14px;line-height:1.65;color:${MUTED};">${esc(pSummary)}</p>
${noteHtml}
</div>`;
        })
        .join("");
      return `<tr><td style="padding:24px 32px 0 32px;">
<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT};font-weight:600;margin-bottom:4px;">${esc(heading)}</div>
${items}
</td></tr>`;
    })
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${CARD};border:1px solid ${RULE};border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 32px 0 32px;">
<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${esc(siteName)} · Issue ${no} · ${esc(issue.dateStart)} → ${esc(issue.dateEnd)}</div>
<h1 style="margin:8px 0 12px 0;font-size:26px;line-height:1.25;color:${INK};">${esc(title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.75;color:${MUTED};">${esc(intro)}</p>
</td></tr>
${sectionsHtml}
<tr><td style="padding:24px 32px 32px 32px;">
<a href="${base}/weekly/${issue.number}" style="display:inline-block;padding:11px 24px;border-radius:8px;background:${ACCENT};color:#fff;font-size:14px;font-weight:600;text-decoration:none;">${zh ? "在网页上阅读本期 →" : "Read this issue on the web →"}</a>
</td></tr>
<tr><td style="padding:20px 32px 28px 32px;border-top:1px solid ${RULE};color:${MUTED};font-size:12px;line-height:1.7;">
${esc(siteName)} · <a href="${base}" style="color:${MUTED};">${esc(base.replace(/^https?:\/\//, ""))}</a><br>
${zh ? "不想再收到？" : "Don't want these?"} <a href="${esc(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">${zh ? "退订" : "Unsubscribe"}</a>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const textLines: string[] = [
    `${siteName} · Issue ${no} · ${issue.dateStart} → ${issue.dateEnd}`,
    title,
    "",
    intro,
    "",
  ];
  for (const g of groups) {
    textLines.push((zh ? g.zh : g.en).toUpperCase());
    for (const p of g.picks) {
      textLines.push(`- ${zh ? p.title_zh : p.title_en}`);
      textLines.push(`  ${base}/a/${p.slug}`);
    }
    textLines.push("");
  }
  textLines.push(`${zh ? "在网页上阅读" : "Read on the web"}: ${base}/weekly/${issue.number}`);
  textLines.push(`${zh ? "退订" : "Unsubscribe"}: ${unsubscribeUrl}`);

  return { subject, html, text: textLines.join("\n") };
}
