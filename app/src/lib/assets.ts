/**
 * Cache-busting version for the global stylesheet.
 *
 * `/styles.css` is served with a 4-hour browser cache and a fixed path, so
 * without a version query a returning visitor keeps an old stylesheet against
 * fresh HTML (duplicate list markers, missing stretched-link, broken layout).
 * Bump this on ANY change to public/styles.css; every layout that links the
 * sheet imports this one constant so they can't drift out of sync.
 */
export const CSS_VERSION = "20260531h";
