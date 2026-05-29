import type { APIRoute } from "astro";
import { eq, sql } from "drizzle-orm";
import { db } from "~/db/client";
import { weeklyIssues, weeklyDeliveries } from "~/db/schema";
import {
  weeklyById,
  picksForWeekly,
  confirmedSubscribers,
  sentEmailsForIssue,
} from "~/lib/queries";
import { buildWeeklyGroups, type LayoutSection } from "~/lib/weekly";
import { sendEmailBatch, emailEnabled, type EmailMessage } from "~/lib/email";
import { renderWeeklyEmail, type EmailGroup } from "~/lib/email-templates";
import { signToken } from "~/lib/auth";

export const prerender = false;

function page(title: string, bodyHtml: string): Response {
  return new Response(
    `<!doctype html><html lang=zh-CN><meta charset=utf-8><title>${title}</title><link rel=stylesheet href=/styles.css><body data-lang=zh><main class=container style="padding-top:64px;max-width:640px">${bodyHtml}</main>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Editor-triggered weekly blast. Sends the published issue to every confirmed,
 * non-unsubscribed subscriber in their preferred language. Idempotent by
 * default: recipients already recorded as 'sent' for this issue are skipped, so
 * re-clicking only fills gaps. `?resend=1` re-sends to the whole audience.
 */
export const POST: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const id = ctx.params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const drizzleDb = db(env.DB);
  const backLink = `<p><a class="btn btn-primary" href="/admin/weekly/${id}">← 回到这一期</a></p>`;

  const issue = await weeklyById(drizzleDb, id);
  if (!issue) return new Response("not found", { status: 404 });
  if (!issue.publishedAt) {
    return page("未发布", `<h1>先发布再发送</h1><p>这一期还是草稿，发布之后才能发邮件。</p>${backLink}`);
  }

  const resend = new URL(ctx.request.url).searchParams.get("resend") === "1";

  const allRecipients = await confirmedSubscribers(drizzleDb);
  const alreadySent = resend ? new Set<string>() : await sentEmailsForIssue(drizzleDb, id);
  const recipients = allRecipients.filter((r) => !alreadySent.has(r.email));

  if (recipients.length === 0) {
    const why =
      allRecipients.length === 0
        ? "目前没有已确认的订阅者。"
        : "所有已确认订阅者都已经收到这一期了（用 ?resend=1 可重发）。";
    return page("无需发送", `<h1>没有要发送的对象</h1><p>${why}</p>${backLink}`);
  }

  const picks = await picksForWeekly(drizzleDb, id);
  const layout: LayoutSection[] = issue.layoutJson ? JSON.parse(issue.layoutJson) : [];
  const groups = buildWeeklyGroups(layout, picks);
  const emailGroups: EmailGroup[] = groups.map((g) => ({
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

  const base = (env.SITE_URL || "").replace(/\/$/, "");
  const siteName = env.SITE_NAME || "Glean";
  const signingKey = env.COOKIE_SIGNING_KEY || "dev-key-please-set";

  const issueMeta = {
    number: issue.number,
    titleZh: issue.titleZh,
    titleEn: issue.titleEn,
    introZh: issue.introZh,
    introEn: issue.introEn,
    dateStart: issue.dateStart,
    dateEnd: issue.dateEnd,
  };

  const messages: EmailMessage[] = [];
  for (const r of recipients) {
    const token = await signToken(signingKey, { e: r.email });
    const unsubscribeUrl = `${base}/api/subscribe/unsubscribe?t=${encodeURIComponent(token)}`;
    const mail = renderWeeklyEmail({
      lang: r.langPref,
      siteName,
      siteUrl: base,
      issue: issueMeta,
      groups: emailGroups,
      unsubscribeUrl,
    });
    messages.push({
      to: r.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  }

  const results = await sendEmailBatch(env, messages);
  const now = new Date();

  // Record each attempt (idempotent on the (issue,email) PK). Multi-row upserts
  // chunked to keep the D1 statement size and subrequest count modest.
  const rows = results.map((res) => ({
    issueId: id,
    email: res.to,
    status: (res.ok ? "sent" : "failed") as "sent" | "failed",
    error: res.ok ? null : (res.error ?? "unknown").slice(0, 500),
    sentAt: now,
  }));
  for (let i = 0; i < rows.length; i += 50) {
    await drizzleDb
      .insert(weeklyDeliveries)
      .values(rows.slice(i, i + 50))
      .onConflictDoUpdate({
        target: [weeklyDeliveries.issueId, weeklyDeliveries.email],
        set: {
          status: sql`excluded.status`,
          error: sql`excluded.error`,
          sentAt: sql`excluded.sent_at`,
        },
      });
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;

  // Stamp first-sent time once (kept as the original blast time on re-sends).
  if (sent > 0 && !issue.emailSentAt) {
    await drizzleDb.update(weeklyIssues).set({ emailSentAt: now }).where(eq(weeklyIssues.id, id));
  }

  const note = emailEnabled(env)
    ? ""
    : `<p style="color:#b45309">注意：没有配置 RESEND_API_KEY，这些邮件只写进了日志、并没有真的发出（本地开发模式）。</p>`;

  return page(
    "发送完成",
    `<h1>发送完成</h1>
<p>成功 <strong>${sent}</strong> 封${failed > 0 ? `，失败 <strong style="color:#c00">${failed}</strong> 封` : ""}。
受众共 ${allRecipients.length} 人${alreadySent.size > 0 ? `，跳过已发送 ${alreadySent.size} 人` : ""}。</p>
${note}${backLink}`,
  );
};
