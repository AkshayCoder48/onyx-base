// esbuild script: bundles the OpenNext Workers build into a single
// Pages-compatible `_worker.js` file.
//
// Why this exists:
// @opennextjs/cloudflare v1.x produces a Workers-mode bundle (with Durable
// Object exports). Cloudflare PAGES does not support DO exports, so we
// re-bundle the worker entry point into a single self-contained file that
// drops the DO exports (they are "dummy" stubs anyway per open-next.config.ts)
// and keeps `node:*` + `.wasm` imports external (resolved by the Workers
// runtime via `nodejs_compat` + native WASM support).

import { build, build as esbuildBuild } from 'esbuild'
import { readFileSync } from 'node:fs'

const entry = '.open-next/pages-worker-entry.js'
const outdir = '.open-next/assets/_worker.js'

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node', // externalize node: built-ins (fs, path, crypto, etc.)
  target: 'es2022',
  outdir,
  entryNames: 'index',
  // Keep cloudflare: imports external (Workers runtime provides them)
  external: ['cloudflare:*'],
  // Native WASM imports: keep them as external ESM imports. The Cloudflare
  // runtime natively resolves `import wasm from './x.wasm'` to a
  // WebAssembly.Module instance. esbuild's built-in wasm loaders (base64,
  // file, copy) would all BREAK this runtime resolution, so we MUST keep
  // them external via a plugin.
  plugins: [
    {
      name: 'stub-wasm',
      setup(build) {
        // Stub out all .wasm imports. Prisma's WASM query engine cannot run
        // on Cloudflare Pages (read-only filesystem, no SQLite), and the
        // Prisma client is lazily loaded (only when SQL features are used).
        // Replacing the WASM import with an empty default export lets the
        // bundle deploy cleanly. If a user invokes SQL features, Prisma's
        // lazy init throws — which is caught by the try/catch in db.ts.
        build.onResolve({ filter: /\.wasm$/ }, () => ({
          path: 'stub-wasm',
          namespace: 'stub-wasm-ns',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub-wasm-ns' }, () => ({
          contents: 'export default null; export const __stub = true;',
          loader: 'js',
        }))
      },
    },
  ],
  logLevel: 'warning',
  logLimit: 10,
  banner: {
    js: [
      'globalThis.openNextDebug = false; globalThis.openNextVersion = "4.0.2"; globalThis.nextVersion = "16.1.3";',
      '// ─── Cloudflare Workers `require` shim ───────────────────────────────',
      '// Next.js internals use CommonJS `require("fs")` etc. Workers ESM has',
      '// no `require`. We import the available node:* built-ins statically',
      '// and expose them via a `require()` function so the bundled __require',
      '// helper finds them. Unavailable modules (child_process, net, tls, tty,',
      '// vm) return an empty object — they are imported by Next.js internals',
      '// at module-load but never invoked in production server rendering.',
      'import * as __m_async_hooks from "node:async_hooks";',
      'import * as __m_buffer from "node:buffer";',
      'import * as __m_crypto from "node:crypto";',
      'import * as __m_events from "node:events";',
      'import * as __m_fs from "node:fs";',
      'import * as __m_http from "node:http";',
      'import * as __m_https from "node:https";',
      'import * as __m_os from "node:os";',
      'import * as __m_path from "node:path";',
      'import * as __m_process from "node:process";',
      'import * as __m_stream from "node:stream";',
      'import * as __m_timers from "node:timers";',
      'import * as __m_url from "node:url";',
      'import * as __m_util from "node:util";',
      'import * as __m_zlib from "node:zlib";',
      'import * as __m_module from "node:module";',
      'var __cfModules = {',
      '  "async_hooks": __m_async_hooks, "node:async_hooks": __m_async_hooks,',
      '  "buffer": __m_buffer, "node:buffer": __m_buffer,',
      '  "crypto": __m_crypto, "node:crypto": __m_crypto,',
      '  "events": __m_events, "node:events": __m_events,',
      '  "fs": __m_fs, "node:fs": __m_fs,',
      '  "fs/promises": __m_fs.promises || {}, "node:fs/promises": __m_fs.promises || {},',
      '  "http": __m_http, "node:http": __m_http,',
      '  "https": __m_https, "node:https": __m_https,',
      '  "os": __m_os, "node:os": __m_os,',
      '  "path": __m_path, "node:path": __m_path,',
      '  "process": __m_process, "node:process": __m_process,',
      '  "stream": __m_stream, "node:stream": __m_stream,',
      '  "stream/promises": __m_stream.promises || {}, "node:stream/promises": __m_stream.promises || {},',
      '  "stream/web": __m_stream.web || {}, "node:stream/web": __m_stream.web || {},',
      '  "timers": __m_timers, "node:timers": __m_timers,',
      '  "timers/promises": __m_timers.promises || {}, "node:timers/promises": __m_timers.promises || {},',
      '  "url": __m_url, "node:url": __m_url,',
      '  "util": __m_util, "node:util": __m_util,',
      '  "zlib": __m_zlib, "node:zlib": __m_zlib,',
      '  "module": __m_module, "node:module": __m_module,',
      '  "child_process": {}, "node:child_process": {},',
      '  "net": {}, "node:net": {},',
      '  "tls": {}, "node:tls": {},',
      '  "tty": { isatty: () => false }, "node:tty": { isatty: () => false },',
      '  "vm": {}, "node:vm": {},',
      '};',
      'var __cfModuleCache = {};',
      'var require = (name) => {',
      '  if (name in __cfModules) {',
      '    if (!__cfModuleCache[name]) {',
      '      const mod = __cfModules[name];',
      '      if (mod && typeof mod === "object" && Object.keys(mod).length > 0) {',
      '        // Return a MUTABLE shallow copy of the ESM namespace.',
      '        // Next.js patches module exports (timers.setImmediate,',
      '        // crypto.randomUUID) which requires writable properties —',
      '        // ESM namespaces are frozen, so we copy values into a plain',
      '        // object. Class/function references are preserved by value.',
      '        __cfModuleCache[name] = Object.assign({}, mod);',
      '      } else {',
      '        __cfModuleCache[name] = mod || {};',
      '      }',
      '    }',
      '    return __cfModuleCache[name];',
      '  }',
      '  // Unknown module — return empty object instead of crashing (some',
      '  // Next.js internals import modules that are never used at runtime).',
      '  return {};',
      '};',
    ].join('\n'),
  },
})

console.log('✓ Pages worker bundle written to', outdir)
