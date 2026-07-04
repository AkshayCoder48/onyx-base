// Pages-compatible entry point for OpenNext Cloudflare build.
//
// WHY THIS EXISTS:
// @opennextjs/cloudflare v1.x produces a Workers-mode bundle (worker.js with
// `export { DOQueueHandler } ...` Durable Object exports). Cloudflare PAGES
// does not support Durable Object exports — only Cloudflare WORKERS do.
//
// Since our open-next.config.ts uses "dummy" overrides for
// incrementalCache / tagCache / queue / cachePurge, the DO classes are
// never actually instantiated at runtime. We can safely drop their exports
// for a Pages-compatible bundle.
//
// This file is bundled by esbuild into a single self-contained
// `_worker.js` that is deployed to the Pages project's assets directory.

import { handleCdnCgiImageRequest, handleImageRequest } from "../cloudflare/images.js";
import { runWithCloudflareRequestContext } from "../cloudflare/init.js";
import { maybeGetSkewProtectionResponse } from "../cloudflare/skew-protection.js";
import { handler as middlewareHandler } from "../middleware/handler.mjs";

export default {
  async fetch(request, env, ctx) {
    return runWithCloudflareRequestContext(request, env, ctx, async () => {
      const response = maybeGetSkewProtectionResponse(request);
      if (response) {
        return response;
      }
      const url = new URL(request.url);
      if (url.pathname.startsWith("/cdn-cgi/image/")) {
        return handleCdnCgiImageRequest(url, env);
      }
      if (
        url.pathname ===
        `${globalThis.__NEXT_BASE_PATH__}/_next/image${globalThis.__TRAILING_SLASH__ ? "/" : ""}`
      ) {
        return await handleImageRequest(url, request.headers, env);
      }
      const reqOrResp = await middlewareHandler(request, env, ctx);
      if (reqOrResp instanceof Response) {
        return reqOrResp;
      }
      const { handler } = await import("../server-functions/default/handler.mjs");
      return handler(reqOrResp, env, ctx, request.signal);
    });
  },
};
