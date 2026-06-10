import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  // `site` is resolved at BUILD time (powers canonical URLs + the sitemap).
  // The runtime SITE_URL var (wrangler.toml [vars]) can't reach config here,
  // so the real production domain is the default — keep in sync with
  // wrangler.toml's SITE_URL.
  site: process.env.SITE_URL ?? "https://glean.smartcoder.ai",
  output: "hybrid",
  adapter: cloudflare({
    platformProxy: { enabled: true },
    imageService: "passthrough",
    // No routes.extend needed: with 404.astro SSR (the only non-prerendered
    // page left was the 404), the adapter emits a catch-all "/*" include, so
    // every path — including /about/ trailing-slash variants — reaches the
    // worker and the middleware's canonicalization 301 can fire.
  }),
  integrations: [],
  // No vite overrides needed: the heavy AI/extract deps live in the
  // dedicated `workers/ingest-consumer/` worker, which Wrangler bundles
  // via esbuild (handles CJS without issue).
  // "ignore" (not "never") so trailing-slash URLs MATCH a route → middleware
  // runs → it 301-redirects them to the canonical no-slash URL. Under "never"
  // they were unmatched and 404'd before middleware could redirect.
  trailingSlash: "ignore",
  compressHTML: true,
});
