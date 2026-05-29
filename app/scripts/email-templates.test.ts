import assert from "node:assert/strict";
import {
  renderConfirmEmail,
  renderWeeklyEmail,
  type EmailGroup,
  type WeeklyIssueMeta,
} from "../src/lib/email-templates";

// --- confirmation email ---------------------------------------------------
const confirmUrl = "https://glean.smartcoder.ai/api/subscribe/confirm?t=abc.def";
const cz = renderConfirmEmail({ lang: "zh", siteName: "Glean", confirmUrl });
assert.ok(cz.subject.includes("Glean"), "subject names the site");
assert.ok(cz.html.includes(confirmUrl), "html embeds the confirm link");
assert.ok(cz.text.includes(confirmUrl), "text embeds the confirm link");

const ce = renderConfirmEmail({ lang: "en", siteName: "Glean", confirmUrl });
assert.ok(/confirm/i.test(ce.subject), "en subject mentions confirm");

// --- weekly email ---------------------------------------------------------
const issue: WeeklyIssueMeta = {
  number: 7,
  titleZh: "本期标题",
  titleEn: "This Week",
  introZh: "导语中文",
  introEn: "Intro english",
  dateStart: "2026-05-18",
  dateEnd: "2026-05-24",
};
const groups: EmailGroup[] = [
  {
    zh: "推理",
    en: "Inference",
    picks: [
      {
        title_zh: "标题<x>", // contains HTML-significant chars to test escaping
        title_en: "Title & more",
        summary_zh: "摘要",
        summary_en: "summary",
        slug: "my-article",
        source_host: "example.com",
        read_minutes: 6,
        editor_note_zh: "编辑note",
        editor_note_en: "editor note",
      },
    ],
  },
];
const unsubscribeUrl = "https://glean.smartcoder.ai/api/subscribe/unsubscribe?t=uns.tok";

const wz = renderWeeklyEmail({
  lang: "zh",
  siteName: "Glean",
  siteUrl: "https://glean.smartcoder.ai/",
  issue,
  groups,
  unsubscribeUrl,
});
assert.ok(wz.subject.includes("#007"), "subject has zero-padded issue number");
assert.ok(wz.subject.includes("本期标题"), "zh subject uses zh title");
assert.ok(wz.html.includes("/a/my-article"), "links to the article (no double slash)");
assert.ok(!wz.html.includes("//a/my-article"), "trailing slash on siteUrl was trimmed");
assert.ok(wz.html.includes("/weekly/7"), "links to the web issue");
assert.ok(wz.html.includes(unsubscribeUrl), "embeds the unsubscribe link");
assert.ok(wz.html.includes("标题&lt;x&gt;"), "escapes HTML in pick titles");
assert.ok(!wz.html.includes("标题<x>"), "raw unescaped title must not appear");
assert.ok(wz.text.includes(unsubscribeUrl), "text version has unsubscribe link");

const we = renderWeeklyEmail({
  lang: "en",
  siteName: "Glean",
  siteUrl: "https://glean.smartcoder.ai",
  issue,
  groups,
  unsubscribeUrl,
});
assert.ok(we.subject.includes("This Week"), "en subject uses en title");
assert.ok(we.html.includes("Inference"), "en heading rendered");

console.log("email-templates assertions passed");
