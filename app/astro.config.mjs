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
    // Route the exact-match SSR pages' trailing-slash variants to the worker
    // so the middleware 301-redirect can fire (wildcard routes like /tag/*
    // already match /tag/foo/). Without this, /about/ etc. miss every include
    // pattern and Cloudflare serves a static 404 (and _redirects is ignored
    // whenever a _worker.js is present).
    routes: {
      extend: {
        include: [{ pattern: "/about/" }, { pattern: "/standards/" }],
      },
    },
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
