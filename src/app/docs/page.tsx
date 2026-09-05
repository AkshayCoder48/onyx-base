import type { Metadata } from "next";
import { getBaseUrl } from "@/lib/public-url";

export const metadata: Metadata = {
  title: "Onyx Base — API Documentation",
  description:
    "Public REST & GraphQL API reference for Onyx Base: key-value storage, file uploads up to 2 GB via chunked upload, share tokens, and the automated email / Email OTP service (MCPEmail). No login required to read.",
  keywords: ["Onyx Base", "API docs", "REST API", "email OTP", "MCPEmail", "file upload API", "key-value API"],
};

/* ─────────────────────────────────────────────────────────────────────────────
   Public API documentation — viewable anonymously (no key required).
   Covers: quick start, auth, KV core, files (incl. the chunked-upload
   protocol), Email OTP / automated email, share tokens, and advanced APIs.
   ──────────────────────────────────────────────────────────────────────────── */

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Endpoint {
  method: Method;
  path: string;
  title: string;
  auth: boolean;
  description: string;
  body?: string;
  example?: string;
}

const METHOD_STYLES: Record<Method, string> = {
  GET: "bg-emerald-500/12 text-emerald-700 border-emerald-500/30",
  POST: "bg-[#f2521b]/12 text-[#d8410f] border-[#f2521b]/30",
  PUT: "bg-[#ef8f2a]/15 text-[#b06307] border-[#ef8f2a]/35",
  DELETE: "bg-rose-500/12 text-rose-700 border-rose-500/30",
};

function MethodChip({ method }: { method: Method }) {
  return (
    <span
      className={`font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-md border shrink-0 ${METHOD_STYLES[method]}`}
    >
      {method}
    </span>
  );
}

function EndpointCard({ e }: { e: Endpoint }) {
  return (
    <div className="glass-soft rounded-2xl p-4 space-y-2">
      <div className="flex items-start gap-2.5 flex-wrap">
        <MethodChip method={e.method} />
        <code className="font-mono text-[13px] text-foreground break-all leading-relaxed">{e.path}</code>
        {e.auth ? (
          <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-700">
            key required
          </span>
        ) : (
          <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
            public
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-foreground/90">{e.title}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{e.description}</p>
      {e.body && (
        <div className="text-[12px] leading-relaxed text-muted-foreground/90">
          <span className="font-mono text-[10px] uppercase tracking-wider text-primary">body</span>{" "}
          <code className="font-mono break-all">{e.body}</code>
        </div>
      )}
      {e.example && (
        <pre className="mt-1 rounded-xl bg-[#2a1c14]/92 text-[#ffd9a8] font-mono text-[11.5px] leading-relaxed p-3 overflow-x-auto">
          {e.example}
        </pre>
      )}
    </div>
  );
}

function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-4 space-y-1.5">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-primary">{eyebrow}</div>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground max-w-3xl">{intro}</p>
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

const BASE = getBaseUrl();

const KV_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/v1/set",
    title: "Write a record",
    auth: true,
    description:
      'Stores a JSON value under a key (inside a collection, default "default"). Values can be strings, numbers, booleans, objects or arrays. Every write is mirrored to the durable Telegram backup.',
    body: "{ collection?, key, value }",
    example: `curl -X POST ${BASE}/v1/set \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"user:42","value":{"name":"Ada","plan":"pro"}}'`,
  },
  {
    method: "GET",
    path: "/v1/get/{key}",
    title: "Read a record",
    auth: true,
    description: "Returns the record's value, type, collection, and timestamps. 404 when the key doesn't exist.",
    example: `curl ${BASE}/v1/get/user:42 \\
  -H "Authorization: Bearer kv_live_…"`,
  },
  {
    method: "DELETE",
    path: "/v1/delete/{key}",
    title: "Delete a record",
    auth: true,
    description: "Removes the key from its collection and mirrors the deletion to the backup channel.",
  },
  {
    method: "GET",
    path: "/v1/list",
    title: "List keys",
    auth: true,
    description: "Paginated key listing with optional prefix filtering (?prefix=user:&) and collection scoping.",
  },
  {
    method: "GET",
    path: "/v1/export",
    title: "Export all data",
    auth: true,
    description: "Downloads every record on your account as one JSON document — handy for migrations and backups.",
  },
  {
    method: "GET",
    path: "/v1/stats · /v1/whoami · /v1/health",
    title: "Stats, identity, health",
    auth: true,
    description:
      "/v1/stats returns counts + storage bytes; /v1/whoami verifies your key and echoes account info; /v1/health reports per-subsystem status.",
  },
];

const FILE_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/files",
    title: "Upload a file (single-shot, ≤ 8 MB recommended)",
    auth: true,
    description:
      "Multipart/form-data with a `file` field (any extension). The bytes are streamed to your Telegram-backed storage, indexed, and a permanent /f/{fileId} link is returned. Optional fields: label, public (\"true\"|\"false\").",
    example: `curl -X POST ${BASE}/api/files \\
  -H "Authorization: Bearer kv_live_…" \\
  -F "file=@photo.jpg" -F "label=Q3 report"`,
  },
  {
    method: "GET",
    path: "/api/files",
    title: "List your files",
    auth: true,
    description: "Returns every file on the account with size, label, download counts, and effective upload limits.",
  },
  {
    method: "POST",
    path: "/api/files/upload/init",
    title: "Chunked upload — begin session (ANY file size, up to 2 GB)",
    auth: true,
    description:
      "The reliable path for large files: the client splits the file into 4 MB chunks so every request stays under every platform body limit (Vercel ~4.5 MB, proxies, CDNs). Sessions live 2 hours and are resumable.",
    body: "{ fileName, mimeType, size, label?, isPublic?, chunkSize? }",
    example: `curl -X POST ${BASE}/api/files/upload/init \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"fileName":"backup.tar","mimeType":"application/octet-stream","size":1073741824}'`,
  },
  {
    method: "POST",
    path: "/api/files/upload/chunk?uploadId=…&index=N",
    title: "Chunked upload — send one chunk (raw binary body)",
    auth: true,
    description:
      "Send the RAW chunk bytes as the request body (application/octet-stream). Chunks must match the negotiated size exactly (the last one may be shorter). Idempotent — a retried index safely rewrites its part. 404 SESSION_NOT_FOUND → re-init.",
    example: `curl -X POST "${BASE}/api/files/upload/chunk?uploadId=<uuid>&index=0" \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/octet-stream" \\
  --data-binary @chunk_0.bin`,
  },
  {
    method: "GET",
    path: "/api/files/upload/status?uploadId=…",
    title: "Chunked upload — resume support",
    auth: true,
    description: "Lists received and missing chunk indexes so a dropped connection can resume exactly where it left off.",
  },
  {
    method: "POST",
    path: "/api/files/upload/complete",
    title: "Chunked upload — finalize",
    auth: true,
    description:
      "Verifies the assembled byte count, uploads to storage, registers the file record, cleans the temp session, and returns the same shape as single-shot POST /api/files.",
    body: "{ uploadId }",
  },
  {
    method: "POST",
    path: "/api/files/upload/abort",
    title: "Chunked upload — discard",
    auth: true,
    description: "Frees the session's temp directory immediately instead of waiting for the 2-hour TTL janitor.",
    body: "{ uploadId }",
  },
  {
    method: "POST",
    path: "/api/files/{id}/link",
    title: "Mint a download URL",
    auth: true,
    description:
      "Returns a proxied, permanent download URL plus the raw URL with expiry. Add ?force=1 to bust the 55-minute server cache. POST /api/files/{id}/revoke kills the cached URL.",
  },
];

const EMAIL_ENDPOINTS: Endpoint[] = [
  {
    method: "PUT",
    path: "/api/dashboard/mcpemail-config",
    title: "Configure the automated email service",
    auth: true,
    description:
      "One-time setup: paste your MCPEmail API key (format mcpe_<64-hex>, e.g. mcpe_4c7b1e9a0d5f…) and optional templates. The key is validated with a live mcpemails.com handshake, then stored with your account and mirrored to Telegram — it survives cold boots.",
    body: "{ apiKey, label?, fromName?, subjectTemplate?, bodyTemplate?, testConnection? }",
    example: `curl -X PUT ${BASE}/api/dashboard/mcpemail-config \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"apiKey":"mcpe_4c7b1e9a0d5f…","fromName":"Onyx Base","subjectTemplate":"Your code"}'`,
  },
  {
    method: "POST",
    path: "/api/email-otp/send",
    title: "Send a verification code to any email",
    auth: false,
    description:
      "The automated email endpoint: sends a 6-digit code with a 10-minute expiry. Rate-limited per address (30 s between sends, 10/hour). Works from public apps — no key needed, but the account owner must have configured the email service first.",
    body: "{ email, purpose? }",
    example: `curl -X POST ${BASE}/api/email-otp/send \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com","purpose":"login"}'`,
  },
  {
    method: "POST",
    path: "/api/email-otp/verify",
    title: "Verify a code",
    auth: false,
    description:
      "Checks the 6-digit code against the latest non-expired, non-consumed code for that email. Single-use: a successful verification consumes the code. 410 = expired/used, 404 = nothing was ever sent.",
    body: "{ email, code }",
    example: `curl -X POST ${BASE}/api/email-otp/verify \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com","code":"482913"}'`,
  },
  {
    method: "GET",
    path: "/api/dashboard/mcpemail-config",
    title: "Read the email config (masked)",
    auth: true,
    description: "Shows whether the email service is configured, the masked key (mcpe_4c7b1e9a…6b74), and your templates. DELETE removes the config.",
  },
];

const SHARE_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/dashboard/share-tokens",
    title: "Create a scoped share token",
    auth: true,
    description:
      "Mint a public read/write token for ONE key (optionally one collection) with TTL, rate limits, and value-size caps. Perfect for contact forms, counters, and IoT pushes — no key exposure.",
    body: "{ key, mode: 'read'|'write'|'readwrite', collection?, ttlMinutes?, rateLimitPerMin? }",
  },
  {
    method: "GET",
    path: "/v1/share/{token}",
    title: "Public read via token",
    auth: false,
    description: "Anyone with the token URL can read the scoped key. 404 when revoked or expired.",
  },
  {
    method: "POST",
    path: "/v1/write/{token}",
    title: "Public write via token",
    auth: false,
    description: "Scoped single-key writes: set (capped value length), append, or incr (min/max bounds). Mode must allow write.",
  },
];

const ADVANCED_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/v1/graphql",
    title: "GraphQL endpoint",
    auth: true,
    description:
      "A zero-dependency GraphQL parser — single endpoint for records, collections, apiKeys, logs, and me queries, all scoped to your key.",
    example: `curl -X POST ${BASE}/api/v1/graphql \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ me { userId plan } records(limit: 3) { key value } }"}'`,
  },
  {
    method: "POST",
    path: "/api/v1/rpc/{name}",
    title: "Built-in RPC",
    auth: true,
    description: "Server-side helpers: count_records, sum, aggregate, search, touch — compute without shipping data over the wire.",
  },
  {
    method: "POST",
    path: "/api/v1/views · /api/v1/matviews · /api/v1/functions",
    title: "Views, materialized views, server functions",
    auth: true,
    description:
      "Named projections over collections (views), pre-computed cached aggregations (matviews), and sandboxed server-side JS handlers (functions) with a 5-second timeout.",
  },
  {
    method: "POST",
    path: "/api/dashboard/sql · /api/dashboard/tables",
    title: "SQL editor + structured tables",
    auth: true,
    description:
      "Run SELECT/WITH queries against the virtual tables users, records, api_keys, collections, logs — and create real structured tables with typed schemas via the Tables API.",
  },
  {
    method: "POST",
    path: "/api/auth/register",
    title: "Self-serve signup",
    auth: false,
    description: "POST { name?, email?, password? } → a fresh account + an API key shown exactly once. /api/auth/login and /api/auth/recover handle email+password flows.",
  },
];

/* ── Nav entries for the sticky in-page TOC ── */
const TOC = [
  { id: "quickstart", label: "Quick start" },
  { id: "auth", label: "Authentication" },
  { id: "kv", label: "Key-value API" },
  { id: "files", label: "Files & chunked upload" },
  { id: "email", label: "Email OTP service" },
  { id: "share", label: "Share tokens" },
  { id: "advanced", label: "Advanced" },
  { id: "limits", label: "Limits" },
];

function SunLogo() {
  return (
    <div className="size-9 rounded-2xl bg-gradient-to-br from-[#f2521b] via-[#ef8f2a] to-[#d8410f] flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(242,82,27,0.6)]">
      <svg viewBox="0 0 24 24" fill="none" className="size-5 text-white" aria-hidden="true">
        <circle cx="12" cy="12" r="4.4" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="2.2" x2="12" y2="4.6" />
          <line x1="12" y1="19.4" x2="12" y2="21.8" />
          <line x1="2.2" y1="12" x2="4.6" y2="12" />
          <line x1="19.4" y1="12" x2="21.8" y2="12" />
          <line x1="5.06" y1="5.06" x2="6.76" y2="6.76" />
          <line x1="17.24" y1="17.24" x2="18.94" y2="18.94" />
          <line x1="5.06" y1="18.94" x2="6.76" y2="17.24" />
          <line x1="17.24" y1="6.76" x2="18.94" y2="5.06" />
        </g>
      </svg>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Sticky glass top bar ── */}
      <header className="sticky top-0 z-30 px-3 sm:px-4 pt-3">
        <div className="glass rounded-3xl px-4 sm:px-5 h-[58px] flex items-center gap-3">
          <a href="/docs" className="flex items-center gap-2.5 min-w-0" aria-label="Onyx Base docs home">
            <SunLogo />
            <span className="hidden sm:block font-display text-[15px] font-semibold tracking-tight">
              Onyx Base <span className="text-muted-foreground font-normal">· API Docs</span>
            </span>
          </a>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/api/docs"
              className="glass-soft h-9 rounded-2xl hidden sm:inline-flex items-center gap-2 px-3.5 text-[13px] font-medium text-[#5c5049] hover:brightness-[1.03] transition-all"
              title="Full interactive OpenAPI reference (Swagger UI)"
            >
              <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden="true">
                <path d="M12 3v18M3 12h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Swagger UI
            </a>
            <a
              href="/"
              className="h-9 rounded-2xl inline-flex items-center gap-2 px-4 text-[13px] font-semibold text-white bg-gradient-to-br from-[#f2521b] to-[#d8410f] shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_8px_18px_-8px_rgba(242,82,27,0.65)] hover:brightness-[1.05] transition-all"
            >
              Open app
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        {/* ── Hero ── */}
        <div className="mb-10 lg:mb-14 max-w-3xl">
          <div className="inline-flex items-center gap-2 glass-soft rounded-full px-3 py-1 mb-5">
            <span className="size-1.5 rounded-full bg-primary pulse-dot" />
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              public · no login needed
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
            The Onyx Base <span className="text-coral-gradient">API</span>
            <br />
            documentation.
          </h1>
          <p className="mt-5 text-[15px] sm:text-base leading-relaxed text-muted-foreground">
            A Telegram-backed key-value &amp; file platform. Sign up in the app to mint an{" "}
            <code className="font-mono text-[13px] text-foreground">kv_live_…</code> key, then talk to it over plain
            REST, GraphQL, the CLI, or the dashboard. Files of <strong>any size</strong> (up to 2 GB) upload through
            the chunked protocol, and the built-in automated email service sends verification codes to any address.
            This page is fully public — browse anonymously.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <a
              href="/api/docs"
              className="h-10 rounded-2xl inline-flex items-center gap-2 px-5 text-sm font-semibold text-white bg-gradient-to-br from-[#f2521b] to-[#d8410f] shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_8px_18px_-8px_rgba(242,82,27,0.65)] hover:brightness-[1.05] transition-all"
            >
              Interactive Swagger UI
            </a>
            <a
              href="/api/openapi.json"
              className="glass-soft h-10 rounded-2xl inline-flex items-center gap-2 px-5 text-sm font-medium text-[#5c5049] hover:brightness-[1.03] transition-all"
            >
              OpenAPI 3.0 JSON
            </a>
            <a
              href="/llms.txt"
              className="glass-soft h-10 rounded-2xl inline-flex items-center gap-2 px-5 text-sm font-medium text-[#5c5049] hover:brightness-[1.03] transition-all"
            >
              llms.txt
            </a>
          </div>
        </div>

        {/* ── Section TOC (sticky on xl) ── */}
        <nav className="hidden xl:block float-right w-44 sticky top-24 mr-[-11.5rem] mb-8" aria-label="On this page">
          <div className="glass-soft rounded-2xl p-3 space-y-0.5">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 px-2 pb-1.5">
              On this page
            </div>
            {TOC.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className="block px-2 py-1.5 rounded-lg text-[12.5px] text-[#5c5049] hover:text-foreground hover:bg-white/60 transition-all"
              >
                {t.label}
              </a>
            ))}
          </div>
        </nav>

        <div className="space-y-12 lg:space-y-16 xl:max-w-[calc(100%-1rem)]">
          {/* ── Quick start ── */}
          <Section
            id="quickstart"
            eyebrow="01 · quick start"
            title="From zero to first write in 60 seconds"
            intro="Sign up with just a name (email optional) and the app mints your API key — displayed exactly once. From then on, every request carries it as a Bearer token. No billing, no project setup, no connection strings."
          >
            <div className="grid md:grid-cols-3 gap-3">
              {[
                {
                  n: "1",
                  t: "Create an account",
                  d: "Open the app → “Get started” → enter any name. Your kv_live_… key appears instantly. Store it — it's shown only once (recoverable via email).",
                },
                {
                  n: "2",
                  t: "Make your first call",
                  d: "curl -X POST /v1/set with the Bearer key and any JSON value. That's it — your data is stored and mirrored to the Telegram backup channel.",
                },
                {
                  n: "3",
                  t: "Use it anywhere",
                  d: "The same key powers the web dashboard, the onyx CLI (onyx login --server <url> --key <key>), and every REST/GraphQL endpoint on this page.",
                },
              ].map((s) => (
                <div key={s.n} className="glass rounded-3xl p-5 space-y-2.5">
                  <div className="size-8 rounded-xl bg-gradient-to-br from-[#f2521b] to-[#ef8f2a] text-white font-mono font-bold text-sm flex items-center justify-center shadow-[0_6px_16px_-6px_rgba(242,82,27,0.6)]">
                    {s.n}
                  </div>
                  <h3 className="text-[15px] font-semibold">{s.t}</h3>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">{s.d}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* ── Authentication ── */}
          <Section
            id="auth"
            eyebrow="02 · authentication"
            title="One key, every surface"
            intro="Pass your API key as an Authorization: Bearer header. Regular users get kv_live_… keys; instance operators hold onyxbase_… admin keys that additionally unlock /api/admin/*. Lost keys are recoverable via the email you set on the account."
          >
            <div className="glass rounded-3xl p-5 space-y-4">
              <pre className="rounded-xl bg-[#2a1c14]/92 text-[#ffd9a8] font-mono text-[11.5px] leading-relaxed p-3.5 overflow-x-auto">{`# Every authenticated endpoint accepts the same header:
Authorization: Bearer kv_live_aa6d…3d11

# Wrong/revoked key → 401 { "ok": false, "error": "Unauthorized." }
# Backend temporarily unreachable → 503 (your session stays valid — just retry)`}</pre>
              <div className="grid sm:grid-cols-3 gap-3 text-[13px]">
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">user key</div>
                  <code className="font-mono text-xs">kv_live_…</code>
                  <p className="text-muted-foreground text-[12px] leading-relaxed">Reads/writes only its own account's data.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">admin key</div>
                  <code className="font-mono text-xs">onyxbase_…</code>
                  <p className="text-muted-foreground text-[12px] leading-relaxed">Operator key — user powers plus /api/admin/*.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">share token</div>
                  <code className="font-mono text-xs">shr_…</code>
                  <p className="text-muted-foreground text-[12px] leading-relaxed">Scoped public read/write to ONE key.</p>
                </div>
              </div>
            </div>
          </Section>

          {/* ── KV core ── */}
          <Section
            id="kv"
            eyebrow="03 · core api"
            title="Key-value storage"
            intro="Plain REST over collections of JSON records. SQLite is the fast local index; a private Telegram channel is the durable mirror — cold boots rehydrate automatically from it. Collections group records and are created on first write."
          >
            {KV_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>

          {/* ── Files & chunked upload ── */}
          <Section
            id="files"
            eyebrow="04 · storage"
            title="Files — any size, any extension"
            intro="Files stream to Telegram-backed storage (50 MB per file on the cloud Bot API; 2 GB with a self-hosted local Bot API server). Small files take the single-shot route; large files MUST take the chunked protocol — it splits the transfer into 4 MB requests that pass every platform's body limit, retries individual chunks, and resumes after dropped connections. The server assembles on disk, so memory stays bounded no matter the file size."
          >
            <div className="glass rounded-3xl p-5 space-y-3">
              <h3 className="text-[15px] font-semibold">The chunked flow (what the dashboard does automatically)</h3>
              <div className="grid sm:grid-cols-4 gap-2.5 text-[12px]">
                {[
                  { s: "init", d: "POST metadata → uploadId + negotiated chunkSize" },
                  { s: "chunk ×N", d: "Raw 4 MB bodies → written to disk server-side" },
                  { s: "status", d: "Missing indexes → resume after any network drop" },
                  { s: "complete", d: "Assemble → verify size → Telegram → file record" },
                ].map((step, i) => (
                  <div key={step.s} className="glass-soft rounded-2xl p-3 space-y-1">
                    <div className="font-mono text-[10px] text-primary">STEP {i + 1}</div>
                    <div className="font-mono text-[12px] font-semibold">{step.s}</div>
                    <p className="text-muted-foreground text-[11.5px] leading-relaxed">{step.d}</p>
                  </div>
                ))}
              </div>
              <p className="text-[12.5px] text-muted-foreground leading-relaxed">
                Sessions expire after 2 hours and an automatic janitor sweeps abandoned uploads — a cron-able script
                (<code className="font-mono text-[11.5px]">scripts/cleanup-stale-uploads.ts</code>) also monitors the
                server and restarts it if it ever goes down (502 self-heal).
              </p>
            </div>
            {FILE_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>

          {/* ── Email OTP ── */}
          <Section
            id="email"
            eyebrow="05 · automated email"
            title="Email OTP service (MCPEmail)"
            intro="A built-in automated email sender for verification codes, login flows, and any 6-digit OTP use case — powered by your MCPEmail API key. Configure once from the dashboard (Email OTP tab) or via PUT /api/dashboard/mcpemail-config; after that, the send/verify pair is PUBLIC — your frontend apps can call it directly without exposing any key. Codes expire in 10 minutes, are single-use, and the whole config survives cold boots via the Telegram mirror."
          >
            <div className="glass rounded-3xl p-5 space-y-4">
              <h3 className="text-[15px] font-semibold">Typical signup/login flow</h3>
              <pre className="rounded-xl bg-[#2a1c14]/92 text-[#ffd9a8] font-mono text-[11.5px] leading-relaxed p-3.5 overflow-x-auto">{`// 1. One-time setup (dashboard → Email OTP tab, or):
PUT /api/dashboard/mcpemail-config
{ "apiKey": "mcpe_4c7b1e9a0d5f…",       // mcpe_<64-hex> — validated live
  "fromName": "Acme",
  "subjectTemplate": "Your Acme code",
  "bodyTemplate": "Code: {{code}} (10 min)" }

// 2. Your public login page — no secret on the client:
POST /api/email-otp/send     { "email": "user@example.com" }   → 200
POST /api/email-otp/verify   { "email": "user@example.com", "code": "482913" } → 200`}</pre>
              <div className="grid sm:grid-cols-3 gap-3 text-[12.5px]">
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">key format</div>
                  <code className="font-mono text-xs">mcpe_&lt;64 hex&gt;</code>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">e.g. mcpe_4c7b1e9a0d5f…6b74. Format-checked locally, validated live against mcpemails.com.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">limits</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">10-minute code TTL · single-use · 30 s between sends · 10 sends/hour per address.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">templates</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">Subject + body accept the {"{{code}}"} placeholder; fromName brands the sender.</p>
                </div>
              </div>
            </div>
            {EMAIL_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>

          {/* ── Share tokens ── */}
          <Section
            id="share"
            eyebrow="06 · public access"
            title="Share tokens — scoped public reads &amp; writes"
            intro="Give strangers narrowly-scoped access to exactly one key: a counter a visitor may increment, a form that may append, a status page anyone may read. Tokens carry their own TTL, rate limit, and value-size caps — your API key never leaves the server."
          >
            {SHARE_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>

          {/* ── Advanced ── */}
          <Section
            id="advanced"
            eyebrow="07 · power tools"
            title="GraphQL, RPC, views, functions, SQL"
            intro="Everything else the platform computes server-side: a dependency-free GraphQL parser, built-in aggregation RPCs, named views and cached materialized views, sandboxed server-side JavaScript functions, and a user-scoped SQL editor over virtual tables."
          >
            {ADVANCED_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>

          {/* ── Limits ── */}
          <Section
            id="limits"
            eyebrow="08 · reference"
            title="Limits &amp; platform notes"
            intro="The generous ceilings that keep Onyx Base free, plus where the platform's own boundaries apply. Everything on the user side is unlimited in count — the limits below are per-item sizes and fairness caps."
          >
            <div className="glass rounded-3xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-white/60 text-left">
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">resource</th>
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">limit</th>
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/40">
                  {[
                    ["Records & collections", "Unlimited count", "Fair-use rate caps per key; every write mirrored to Telegram."],
                    ["Single value size", "≈ 4 KB (Telegram message)", "Larger blobs belong in the Files API."],
                    ["File size — cloud Bot API", "50 MB", "Per-file. Unlimited number of files."],
                    ["File size — local Bot API", "2 GB", "Self-host telegram-bot-api for the big ceiling; chunked upload required."],
                    ["Chunked upload session", "2 hours TTL", "Resumable via /status; janitor sweeps expired sessions."],
                    ["Chunk size", "256 KB – 32 MB", "Default 4 MB — safely under serverless body limits."],
                    ["Email OTP code", "10 min TTL, single-use", "30 s between sends, 10/hour per address."],
                    ["Serverless request body", "~4.5 MB (Vercel)", "Platform-imposed — the reason the chunked protocol exists."],
                  ].map((row) => (
                    <tr key={row[0]}>
                      <td className="px-4 py-2.5 font-medium">{row[0]}</td>
                      <td className="px-4 py-2.5 font-mono text-[12px] text-primary whitespace-nowrap">{row[1]}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-[12.5px]">{row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="mt-auto">
        <div className="mx-3 mb-3 glass-soft rounded-2xl px-4 h-11 flex items-center justify-between text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-display font-semibold text-foreground/70">Onyx Base</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline truncate">Telegram-backed key-value &amp; file store</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a href="/api/docs" className="hover:text-foreground transition-colors">Swagger</a>
            <a href="/api/openapi.json" className="hover:text-foreground transition-colors">OpenAPI</a>
            <a href="/" className="hover:text-foreground transition-colors">Open app</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
