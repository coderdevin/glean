import assert from "node:assert/strict";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { isWeixinUrl, extractWechatFromHtml } from "../src/lib/extract-wechat";

// --- isWeixinUrl detection ---
assert.equal(isWeixinUrl("https://mp.weixin.qq.com/s/BZY8Uq2lZIDtXV6nGO5DAw"), true);
assert.equal(isWeixinUrl("https://mp.weixin.qq.com/s?__biz=abc&mid=123"), true);
assert.equal(isWeixinUrl("http://MP.WEIXIN.QQ.COM/s/x"), true); // host is case-insensitive
assert.equal(isWeixinUrl("https://weixin.qq.com/foo"), false); // not the article host
assert.equal(isWeixinUrl("https://example.com/s/x"), false);
assert.equal(isWeixinUrl("not a url"), false);

// A WeChat-shaped page: the real article sits in #js_content, hidden with
// `visibility:hidden` (revealed by JS at runtime). Around it is the page
// chrome — author block + "继续滑动看下一个" footer nav — that WeChat keeps
// visible. The article paragraph is padded past the 200-char floor.
const ARTICLE_PARAGRAPH = "这是公众号文章的正文。".repeat(40); // ~520 chars
const WECHAT_HTML = `<!doctype html><html><head>
  <title></title>
  <meta property="og:title" content="一篇测试文章标题" />
  <meta property="og:article:author" content="测试作者" />
</head><body>
  <div id="page-content">
    <h1 id="activity-name">一篇测试文章标题</h1>
    <div class="rich_media_content" id="js_content" style="visibility: hidden; opacity: 0;">
      <p>${ARTICLE_PARAGRAPH}</p>
      <p><img data-src="//mmbiz.qpic.cn/foo.jpg" alt="figure" /></p>
    </div>
  </div>
  <div id="js_profile_qrcode">
    <span>测试作者</span>
    <span>继续滑动看下一个</span>
    <span>向上滑动看下一个</span>
  </div>
</body></html>`;

// --- the bug it guards against: Readability strips the hidden article ---
// `_isProbablyVisible` drops any `visibility:hidden` subtree, so the generic
// Tier-2 path keeps only the furniture and never recovers the article.
{
  const { document } = parseHTML(WECHAT_HTML);
  const article = new Readability(document as never, { charThreshold: 200 }).parse();
  const text = article?.textContent ?? "";
  assert.ok(
    !text.includes("这是公众号文章的正文"),
    "regression: Readability should drop the visibility:hidden #js_content (proving why the wechat path exists)",
  );
}

// --- the fix: the wechat path reads #js_content directly and recovers it ---
{
  const result = extractWechatFromHtml(WECHAT_HTML, "https://mp.weixin.qq.com/s/test");
  assert.ok(
    result.textContent.includes("这是公众号文章的正文"),
    "wechat path must recover the hidden #js_content article body",
  );
  // Furniture outside #js_content must NOT bleed in.
  assert.ok(!result.textContent.includes("继续滑动看下一个"), "footer nav must not be included");
  // Title comes from og:title (WeChat ships an empty <title>).
  assert.equal(result.title, "一篇测试文章标题");
  // Lazy `data-src` images are resolved and absolutized against the URL.
  assert.ok(result.textContent.includes("https://mmbiz.qpic.cn/foo.jpg"), "data-src image must be inlined");
  assert.equal(result.detectedLang, "zh");
}

// --- too-short / missing #js_content throws (so extract.ts falls to Jina) ---
assert.throws(
  () => extractWechatFromHtml("<!doctype html><html><body><p>hi</p></body></html>", "https://mp.weixin.qq.com/s/x"),
  /#js_content not found/,
);
assert.throws(
  () =>
    extractWechatFromHtml(
      `<!doctype html><html><body><div id="js_content">short</div></body></html>`,
      "https://mp.weixin.qq.com/s/x",
    ),
  /too short/,
);

console.log("# extract-wechat assertions passed");
