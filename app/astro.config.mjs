import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL ?? "https://your-domain.example",
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
