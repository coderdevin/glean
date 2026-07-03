import MarkdownIt from "markdown-it";

/**
 * Single shared instance — markdown-it is stateless after construction.
 * html:false guards against raw <script>/<iframe> sneaking in from LLM
 * output. linkify auto-detects bare URLs so prompt templates with naked
 * links still render as clickable.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Render an LLM-authored section body (real markdown: fences, headings,
 *  bold, lists, links, inline images) to sanitized HTML. */
export function renderMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  return md.render(text);
}
