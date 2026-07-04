import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Use "dummy" overrides for cache/queue/tag features that require Durable
// Objects. Durable Objects are NOT supported on Cloudflare Pages (only on
// Workers), so we disable them to produce a Pages-compatible bundle.
// The app still functions fully — Telegram remains the durable storage layer,
// and Next.js ISR/revalidation caching is simply disabled (not needed here).
export default defineCloudflareConfig({
  incrementalCache: "dummy",
  tagCache: "dummy",
  queue: "direct",
  cachePurge: "dummy",
});
