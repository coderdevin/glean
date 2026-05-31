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
  }),
  integrations: [],
  // No vite overrides needed: the heavy AI/extract deps live in the
  // dedicated `workers/ingest-consumer/` worker, which Wrangler bundles
  // via esbuild (handles CJS without issue).
  trailingSlash: "never",
  compressHTML: true,
});
