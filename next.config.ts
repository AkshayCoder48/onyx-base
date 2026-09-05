import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  // ─── Large-file upload hardening ──────────────────────────────────────────
  // Next.js 16 buffers request bodies that pass through middleware/proxy with
  // a default 10 MB cap. Anything larger was truncated mid-stream —
  // `req.formData()` then failed parsing and the API returned "Expected
  // multipart/form-data" (users saw broken uploads / 502-style failures).
  //
  // In Next.js 16.1 this option lives under `experimental` and setting BOTH
  // proxyClientMaxBodySize + middlewareClientMaxBodySize throws — so we set
  // only the modern name (the deprecated middleware* alias maps to it
  // internally).
  //
  // 64 MB covers the Telegram cloud Bot API limit (50 MB) with headroom for
  // multipart overhead. Larger files (up to 2 GB with a local Bot API server)
  // use the chunked upload API (`/api/files/upload/*`), which reassembles on
  // disk and never buffers the whole body in memory.
  experimental: {
    proxyClientMaxBodySize: "64mb",
  },
};

export default nextConfig;
