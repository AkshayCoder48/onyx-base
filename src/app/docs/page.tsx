import type { Metadata } from "next";
import { getBaseUrl } from "@/lib/public-url";

export const metadata: Metadata = {
  title: "Onyx Base — API Documentation",
  description:
    "Public REST & GraphQL API reference for Onyx Base: key-value storage, file uploads up to 2 GB via chunked upload, share tokens, and the privacy-first Email Automation API (named MCPEmail credentials, $VAR_NAME$ templates, Telegram credential bridge). No login required to read.",
  keywords: ["Onyx Base", "API docs", "REST API", "email automation", "MCPEmail", "email API", "file upload API", "key-value API"],
};

/* ─────────────────────────────────────────────────────────────────────────────
   Public API documentation — viewable anonymously (no key required).
   Covers: quick start, auth, KV core, files (incl. the chunked-upload
   protocol), the Email Automation API (named credentials + $VAR_NAME$ templates),
   share tokens, and advanced APIs.
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
    title: "Chunked upload — mint the plan (ANY file size, up to 2 GB)",
    auth: true,
    description:
      "The reliable path for large files: the client splits the file into 4 MB chunks so every request stays under every platform body limit (Vercel ~4.5 MB, proxies, CDNs). STATELESS — the server keeps no session; the client echoes the plan fields on every subsequent call, so any instance can serve any step.",
    body: "{ fileName, mimeType, size, label?, isPublic?, chunkSize? }",
    example: `curl -X POST ${BASE}/api/files/upload/init \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"fileName":"backup.tar","mimeType":"application/octet-stream","size":1073741824}'`,
  },
  {
    method: "POST",
    path: "/api/files/upload/chunk?uploadId=…&index=N&chunkCount&chunkSize&size",
    title: "Chunked upload — send one chunk (raw binary body)",
    auth: true,
    description:
      "The RAW chunk bytes (application/octet-stream), sized exactly per the plan (the last may be shorter). The server stages the chunk as a Telegram document in your storage chat and returns { messageId, fileId } — the client collects one ref per chunk and hands the full set to complete. Retried indexes stage a new document; keep the newest ref.",
    example: `curl -X POST "${BASE}/api/files/upload/chunk?uploadId=<uuid>&index=0&chunkCount=256&chunkSize=4194304&size=1073741824" \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/octet-stream" \\
  --data-binary @chunk_0.bin`,
  },
  {
    method: "POST",
    path: "/api/files/upload/status",
    title: "Chunked upload — verify the staged set",
    auth: true,
    description: "POST your collected chunk refs; each is verified against Telegram via getFile (metadata only). Reports missing and size-mismatched indexes so the client knows exactly what to re-send.",
    body: "{ uploadId, chunkCount, chunkSize, size, chunks: [{ index, fileId }] }",
  },
  {
    method: "POST",
    path: "/api/files/upload/complete",
    title: "Chunked upload — finalize",
    auth: true,
    description:
      "Send the plan + ALL chunk refs. ANY server instance downloads the staged chunks, verifies every size, assembles, verifies the byte count, ships to storage, registers the file record, deletes the staged part-messages, and returns the same shape as single-shot POST /api/files.",
    body: "{ uploadId, fileName, mimeType, size, chunkSize, chunkCount, label?, isPublic?, chunks: [{ index, messageId, fileId, storageMode? }] }",
  },
  {
    method: "POST",
    path: "/api/files/upload/abort",
    title: "Chunked upload — discard",
    auth: true,
    description: "Deletes the staged Telegram part-messages you collected (best-effort) so an abandoned transfer leaves the storage chat clean.",
    body: "{ uploadId, chunks: [{ messageId, storageMode? }] }",
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
    method: "POST",
    path: "/api/credentials/connect",
    title: "Connect a NAMED MCPEmail credential (one-time setup)",
    auth: true,
    description:
      "Store YOUR mcpe_ key under a name you choose (personal_email, work_email…). testConnection (default true) validates it with a live mcpemails.com handshake before saving. The credential lives in YOUR account and is mirrored to YOUR private pinned Telegram manifest — the platform never pools user keys, and the response returns only the MASKED key (mcpe_4c7b1e9a…1f3a). Set rateLimitPerMin for a custom MCPEmail send-rate cap per credential.",
    body: "{ name, apiKey, label?, fromName?, rateLimitPerMin?, testConnection? }",
    example: `curl -X POST ${BASE}/api/credentials/connect \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"personal_email","apiKey":"mcpe_4c7b1e9a0d5f…","label":"Personal inbox","rateLimitPerMin":30}'`,
  },
  {
    method: "POST",
    path: "/api/email/send",
    title: "Send an automated email (generic engine)",
    auth: true,
    description:
      "The core automation endpoint. Reference the credential BY NAME — the platform resolves it from your private store and forwards the send to MCPEmail with YOUR key (the platform kv_live_* key is never forwarded upstream). $VAR_NAME$ placeholders in subject/body/htmlBody are substituted from variables; a missing variable aborts the send with 400 missing_variable (never half-rendered). No credential → 404 credential_not_found — the system FAILS CLOSED, there is no project-wide fallback key. Every response carries a request_id.",
    body: "{ credential, to, subject, body?, htmlBody?, variables?, fromName? }",
    example: `curl -X POST ${BASE}/api/email/send \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"credential":"personal_email",
       "to":"user@example.com",
       "subject":"Welcome $NAME$",
       "body":"Hello $NAME$,\\n\\nYour verification code is $OTP$.",
       "variables":{"NAME":"Akshay","OTP":"483921"}}'`,
  },
  {
    method: "POST",
    path: "/api/email/template/send",
    title: "Send with a stored template — one structure, many variables",
    auth: true,
    description:
      "Save an email structure once (name + subject + body [+ htmlBody]), then vary the variables per request. The template is never modified on send. template may also be an inline { subject, body, htmlBody? } object for one-off structures.",
    body: "{ credential, template: name | {subject, body, htmlBody?}, to, variables?, fromName? }",
    example: `curl -X POST ${BASE}/api/email/template/send \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"credential":"personal_email","template":"welcome",
       "to":"user@example.com","variables":{"NAME":"Akshay","OTP":"483921"}}'`,
  },
  {
    method: "GET",
    path: "/api/email/status/{requestId}",
    title: "Check a request by ID (metadata only)",
    auth: true,
    description:
      "Debug by request_id: returns ts, endpoint, credential name, status (sent|failed), latency_ms, upstream_status and error_code. Never email content, recipients or credentials. 7-day retention, tenant-scoped. GET /api/email/requests lists recent sends.",
  },
  {
    method: "GET",
    path: "/api/credentials",
    title: "List / manage credentials (masked)",
    auth: true,
    description:
      "Lists every credential as a masked view with its label, sender name, custom rate limit and last-used time. DELETE /api/credentials/{name} disconnects one — sends then fail closed. GET /api/credentials/{name} fetches a single view. Raw keys are never returned by any endpoint.",
  },
  {
    method: "POST",
    path: "/api/telegram/connect",
    title: "Connect your private Telegram configuration channel",
    auth: true,
    description:
      "Point the credential bridge at YOUR OWN bot + chat ({ chatId, label?, botToken? }) — the pair is validated live against Telegram before saving. Your named credentials are mirrored to this private pinned manifest (durable across cold boots). GET /api/telegram/config shows the masked status; DELETE reverts to server defaults. For private work, use your own credentials — never another person's.",
  },
  {
    method: "POST",
    path: "/api/email-otp/send",
    title: "DEPRECATED — returns 410 with a migration guide",
    auth: false,
    description:
      "The retired Email OTP endpoints (/api/email-otp/send and /api/email-otp/verify) now return 410 Gone with a machine-readable migration body — nothing is processed and no credential is used. Migrate by generating the code in YOUR app and delivering it via POST /api/email/send with the $OTP$ variable.",
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
  { id: "email", label: "Email Automation" },
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
            intro="Files stream to Telegram-backed storage (50 MB per file on the cloud Bot API; 2 GB with a self-hosted local Bot API server). Small files take the single-shot route; large files MUST take the chunked protocol — it splits the transfer into 4 MB requests that pass every platform's body limit and retries individual chunks. The protocol is STATELESS: every chunk is staged immediately as a Telegram document and the client collects the refs, so transfers survive multi-instance serverless routing (no sticky sessions, no affinity)."
          >
            <div className="glass rounded-3xl p-5 space-y-3">
              <h3 className="text-[15px] font-semibold">The chunked flow (what the dashboard does automatically)</h3>
              <div className="grid sm:grid-cols-4 gap-2.5 text-[12px]">
                {[
                  { s: "init", d: "POST metadata → uploadId + negotiated chunkSize (pure math, no server state)" },
                  { s: "chunk ×N", d: "Raw 4 MB bodies → staged as Telegram documents; client collects { messageId, fileId } refs" },
                  { s: "status", d: "Verify the staged set via getFile metadata → re-send only missing/mismatched chunks" },
                  { s: "complete", d: "Any instance downloads + assembles → verify → Telegram → file record + cleanup" },
                ].map((step, i) => (
                  <div key={step.s} className="glass-soft rounded-2xl p-3 space-y-1">
                    <div className="font-mono text-[10px] text-primary">STEP {i + 1}</div>
                    <div className="font-mono text-[12px] font-semibold">{step.s}</div>
                    <p className="text-muted-foreground text-[11.5px] leading-relaxed">{step.d}</p>
                  </div>
                ))}
              </div>
              <p className="text-[12.5px] text-muted-foreground leading-relaxed">
                Give up mid-transfer and the uploader calls <code className="font-mono text-[11.5px]">abort</code> to delete
                the staged part-messages; <code className="font-mono text-[11.5px]">complete</code> cleans them after
                success too. An automatic janitor sweeps crashed assembly workspaces, and a cron-able script
                (<code className="font-mono text-[11.5px]">scripts/cleanup-stale-uploads.ts</code>) also monitors the
                server and restarts it if it ever goes down (502 self-heal).
              </p>
            </div>
            {FILE_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>

          {/* ── Email Automation ── */}
          <Section
            id="email"
            eyebrow="05 · email automation"
            title="Email Automation API — privacy-first (MCPEmail + Telegram bridge)"
            intro="A generic email automation engine — OTP codes, welcome mails, notifications, reports, transactional messages — built around credential ownership: YOU bring the MCPEmail key, YOU pick the Telegram channel it is mirrored to, and your platform API key (kv_live_*) only authenticates the call to this API. The API resolves your credential by NAME and forwards the send to MCPEmail with YOUR key. It never falls back to a project-wide credential — missing credentials fail closed."
          >
            <div className="glass rounded-3xl p-5 space-y-4">
              <div className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-3.5 flex items-start gap-2.5">
                <span className="text-base leading-none mt-0.5">🛡</span>
                <p className="text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
                  <strong>Privacy disclaimer.</strong> For private or sensitive email automation, use your own Telegram
                  credentials and your own MCPEmail API key — never credentials belonging to another person. Your
                  mcpe_* key is a user-owned credential used only to execute requests on your behalf; it is never
                  exposed, logged, or reused for other users. The platform API key (kv_live_*) only authorizes access
                  to this automation service; the MCPEmail key is what authenticates with MCPEmail. Never confuse the two.
                </p>
              </div>
              <h3 className="text-[15px] font-semibold">Two credentials, two jobs</h3>
              <pre className="rounded-xl bg-[#2a1c14]/92 text-[#ffd9a8] font-mono text-[11.5px] leading-relaxed p-3.5 overflow-x-auto">{`YOUR APP ── Bearer kv_live_… (platform key) ──▶ ONYX EMAIL API
                                                    │ authenticate caller
                                                    │ resolve credential "personal_email"
                                                    ▼
                                       YOUR mcpe_* key (from your store)
                                                    │
                                                    ▼
                                              MCPEmail → 📧 email

# 1. Connect YOUR key once (mirrored to YOUR Telegram manifest):
POST /api/credentials/connect
{ "name": "personal_email", "apiKey": "mcpe_4c7b1e9a0d5f…",
  "rateLimitPerMin": 30 }                    // custom rate limit (optional)

# 2. Automate — reference the credential BY NAME:
POST /api/email/send
{ "credential": "personal_email",
  "to": "user@example.com",
  "subject": "Welcome $NAME$",
  "body": "Hello $NAME$, your code is $OTP$.",
  "variables": { "NAME": "Akshay", "OTP": "483921" } }`}</pre>
              <div className="grid sm:grid-cols-3 gap-3 text-[12.5px]">
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">$VAR_NAME$ engine</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">{"$NAME$ · $OTP$ · $RESET_URL$ — same template, different values per request. Unknown variables abort the send (missing_variable), never blank-replaced. Template never rebuilt."}</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">fail closed</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">No project-wide MCPEmail key exists. Unknown credential name → 404 credential_not_found. Cross-user access is blocked — credentials are tenant-scoped.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">observability</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">Every send returns a request_id; GET /api/email/status/{"{requestId}"} shows metadata only (latency, status, credential name) — never content, recipients or keys.</p>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 text-[12.5px]">
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">rate limits</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">Per platform key (your kv_live_* rateLimitPerMin) · per client IP (30/min) · per-credential custom cap (rateLimitPerMin, up to 120/min hard ceiling). Secrets are never logged for rate limiting.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">error codes</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">invalid_api_key · credential_not_found · missing_variable {"{ variable, field }"} · template_not_found · rate_limited · upstream_authentication_failed · upstream_timeout · deprecated (410 on old OTP routes).</p>
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
                    ["Chunked upload chunk", "256 KB – 32 MB each", "Default 4 MB — safely under serverless body limits; staged as Telegram documents."],
                    ["Email automation", "Per-key, per-IP (30/min), per-credential custom cap", "Custom rateLimitPerMin per credential (≤120/min hard ceiling); missing $VAR_NAME$ aborts the send; request status kept 7 days (metadata only)."],
                    ["Serverless request body", "~4.5 MB (Vercel)", "Platform-imposed — the reason the chunked protocol exists."],
                    ["Multi-instance consistency", "Eventual, on instance recycle", "Writes land instantly on the handling instance + the Telegram mirror; other warm instances serve the prior snapshot until they recycle and rehydrate."],
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
