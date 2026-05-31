/**
 * URL-driven bilingual routing. Language is determined by the URL path, not a
 * cookie — this is what makes per-language pages indexable and unambiguous to
 * search + answer engines:
 *
 *   Chinese (default)  →  /            /a/<slug>      /daily/<date>   …
 *   English            →  /en          /en/a/<slug>   /en/daily/<date> …
 *
 * The middleware strips the `/en` prefix and rewrites to the shared route
 * template with `locals.lang = "en"`, so we keep ONE set of page files. Every
 * caller that needs the canonical/hreflang/toggle URL derives it from the
 * language-agnostic `basePath` via `localizedPath`.
 */

export type Lang = "zh" | "en";
export const LANGS: readonly Lang[] = ["zh", "en"];
export const EN_PREFIX = "/en";

/** `<html lang>` value. */
export const htmlLang = (lang: Lang): string => (lang === "zh" ? "zh-CN" : "en");
/** BCP-47 hreflang value. */
export const hreflangCode = (lang: Lang): string => (lang === "zh" ? "zh-CN" : "en");
/** OpenGraph locale. */
export const ogLocale = (lang: Lang): string => (lang === "zh" ? "zh_CN" : "en_US");

/**
 * Split a request path into its language and language-agnostic base path.
 *   "/en/a/x" → { lang: "en", basePath: "/a/x" }
 *   "/en"     → { lang: "en", basePath: "/" }
 *   "/a/x"    → { lang: "zh", basePath: "/a/x" }
 */
export function splitLangPath(pathname: string): { lang: Lang; basePath: string } {
  if (pathname === EN_PREFIX || pathname.startsWith(EN_PREFIX + "/")) {
    return { lang: "en", basePath: pathname.slice(EN_PREFIX.length) || "/" };
  }
  return { lang: "zh", basePath: pathname };
}

/**
 * Build the path for a base path in a given language. Inverse of
 * `splitLangPath`. zh stays at root; en is prefixed with `/en`.
 *   ("/a/x", "en") → "/en/a/x"     ("/", "en") → "/en"
 *   ("/a/x", "zh") → "/a/x"        ("/", "zh") → "/"
 */
export function localizedPath(basePath: string, lang: Lang): string {
  const clean = basePath.startsWith("/") ? basePath : "/" + basePath;
  if (lang === "zh") return clean;
  return clean === "/" ? EN_PREFIX : EN_PREFIX + clean;
}

export const otherLang = (lang: Lang): Lang => (lang === "zh" ? "en" : "zh");
