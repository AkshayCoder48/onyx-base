import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Served at /llms.txt — the llmstxt.org convention: a single-page markdown
// overview of the entire project, optimised for AI agents.
//
// This file is the ONE source of truth that combines every docs tab from the
// in-app Docs view (Overview · Keys & Tokens · Features · REST API · CLI ·
// Realtime · Telegram durability · Roadmap) into a single linear document.
// The dashboard's "Copy for LLMs" button fetches this same text and writes it
// to the clipboard, and the in-app "Single page" tab renders the same content
// verbatim — so humans and LLMs always see the same spec.
const LLMS_TXT = `# Onyx Base

> The key-value & file store that lives in Telegram. A lightweight
> Supabase / Firebase–style developer platform — no database to provision,
> free and unlimited, your data lives in your own Telegram chat.

Onyx Base is a Next.js 16 backend-as-a-service that uses Telegram as its
durable storage layer and SQLite (via Prisma) as a fast local index. Bring a
Bot Token + Chat ID (or use the built-in server-side bot) and you get a
key-value database AND a file store (up to 50 MB upload / 20 MB download via
the cloud Bot API; 2 GB both ways with a self-hosted Local Bot API server),
plus a real-time web dashboard, a REST API, and a zero-dependency CLI.

**Unlimited & free.** Every operation is mirrored into a private Telegram
chat, so your full data and audit log live in Telegram — you can read your
database back from the chat itself. No storage caps. No API-call quotas. No
collection limits. No "contact sales" wall.

This document combines every section of the in-app Docs view into one linear
spec. Use it as a quick reference, or paste it into an LLM as project context.

---

## 1 · Overview

Onyx Base is a key-value store **and** file store that lives inside Telegram.
Every record you set, every file you upload, and every API-key mutation is
mirrored into a private Telegram chat — that mirror is the durable substrate.
A fast in-memory + JSON-on-disk index serves reads, a Socket.io mini-service
pushes \`record:changed\` events to the dashboard in real time, and a single
REST surface (\`/v1/*\`) plus a zero-dependency CLI (\`onyx\`) cover the
developer surface. You bring a Telegram Bot Token + Chat ID (or just use the
built-in server-side bot), and you get an unlimited, free database and file
store with a real-time web dashboard on top.

### Three properties that define the platform

- **Unlimited & free** — No storage caps, no API-call quotas, no collection
  limits, no "contact sales" wall. The only cost is your own Telegram bot —
  talk to [@BotFather](https://t.me/BotFather), it's free.
- **Telegram-backed** — Your full data and audit log live in your Telegram
  chat. Stop using Onyx Base tomorrow and your database is still sitting
  there, fully readable.
- **Stateless server** — The server keeps a fast local index but holds no
  identity state of its own — every request is authenticated via your Bearer
  API key. Clear your browser session and you're signed out, no server-side
  logout needed.

### Architecture in one paragraph

**Clients** (browser dashboard, the \`onyx\` CLI, or any HTTP library) talk
to a single Next.js API core. The core writes to an in-memory store + a
JSON-on-disk cache for fast reads, then **mirrors every mutation** (set /
delete / api-key / collection / file upload / share token) into a private
Telegram chat as a structured message. An identity manifest — the small JSON
document that ties your \`userId\` to your \`apiKey\` hash and collection
list — is **pinned** to the chat after every identity mutation, which is
what lets the platform self-heal after a full reset. A Socket.io mini-service
(port 3003) fans \`record:changed\` events out to every connected dashboard
so the UI updates without polling.

\`\`\`
browser · CLI · HTTP  →  Next.js API core  →  { SQLite index
                                                 Telegram durable storage
                                                 Socket.io realtime service }
\`\`\`

---

## 2 · Keys, Tokens & Sessions

Onyx Base uses three distinct credential types — your master **API key**,
scoped **share tokens**, and short-lived signed **download tokens** — plus a
browser-side **session** store. Each one is minted, scoped, and revoked
independently. Treat them like different keys on your keyring: the API key
opens the front door, share tokens are the spare that only works on the
garage, and download tokens are an AirBnB-style temporary code that expires
by itself.

### 2.1 · API Key — \`kv_live_…\`

Your master credential. The Bearer token used by the dashboard, the \`onyx\`
CLI, and every REST call. Grants full read/write access to everything you
own.

| Property | Value |
|:---|:---|
| **Format** | \`kv_live_<28 hex>\` |
| **Minted** | Dashboard → **API Keys** tab (or returned once at signup). Shown exactly once at creation — copy it before closing the dialog. |
| **Scope** | Full account access: every collection, every key, every file, every share token, every log. Not scoped — it is you. |
| **Lifetime** | No expiry. Lives until you revoke it. Stored as a salted hash on the server; the plaintext is only ever shown once. |
| **Revocation** | Revoke instantly from the API Keys tab (\`DELETE /api/dashboard/api-keys/:id\`). The key stops authenticating on the very next request. |

\`\`\`http
# Every /v1/* and /api/dashboard/* request carries this header:
Authorization: Bearer kv_live_abc123def456…

# Example: set a value
curl -X POST https://onyx.example.com/v1/set \\
  -H "Authorization: Bearer kv_live_abc123def456…" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"coins","value":500}'
\`\`\`

**Survives a full local-store wipe.** Your API key still works even if the
server's local database and JSON cache are completely wiped. On a cache-miss,
the auth layer fetches the **pinned identity manifest** from Telegram,
rehydrates your user + API key records into the local store, and retries —
all transparently. The manifest lives in Telegram; the key matches it; you
authenticate.

### 2.2 · Share Token — \`st_…\`

A public, scoped, rate-limited, expiring, revocable credential that wraps
exactly one \`(collection, key)\` pair. Safe to embed in source-visible HTML
(CodePen, static sites, browser extensions).

| Property | Value |
|:---|:---|
| **Format** | \`st_<random>\` |
| **Minted** | Dashboard → **Public Share** tab (\`POST /api/dashboard/share-tokens\`). Choose mode (read / write / readwrite), allowed ops, rate limit, and TTL. |
| **Scope** | One \`(collection, key)\` pair. A read token can only read that one key; a write token can only mutate that one key. It cannot touch anything else in your account. |
| **Lifetime** | Optional TTL (in minutes). No TTL = never expires. Rate-limited per IP, per minute. Revoke at any time. |
| **Revocation** | Revoke instantly from the Public Share tab (\`DELETE /api/dashboard/share-tokens/:id\`). The public URL returns 404 on the very next request. Cannot be undone — create a new token and update your HTML. |

\`\`\`http
# Read token (mode: read) — public, no auth header
curl https://onyx.example.com/v1/share/st_YOUR_READ_TOKEN
# → {"ok":true,"key":"visits","value":42,"type":"number"}

# Write token (mode: write, allowedOps: ["incr"]) — public, no auth
curl -X POST https://onyx.example.com/v1/write/st_YOUR_WRITE_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"op":"incr","amount":1}'
# → {"ok":true,"op":"incr","value":43,"previous":42,"type":"number"}
\`\`\`

#### Share token modes & options

- **Read** — \`GET /v1/share/:token\`. Returns the value, type, and
  updatedAt. Cannot mutate. Pairs with a separate write token if you need
  both.
- **Write** — \`POST /v1/write/:token\`. Mutate only — set / incr / append.
  Cannot read the value back. Use a second read token for that.
- **Read + Write** — Both endpoints work. Convenient for embedded widgets
  that read AND mutate (e.g. a vote button that increments and displays the
  new count).

| Option | Meaning |
|:---|:---|
| **Allowed ops** | \`set\`, \`incr\`, \`append\`. Pick any subset for write modes. An incr-only token can't overwrite the value. |
| **Max value length** | Caps the byte length of \`set\` and \`append\` bodies. Default \`4096\`; \`0\` = unlimited. |
| **Incr bounds** | \`incrMin\` / \`incrMax\` clamp the result of \`incr\` so a runaway counter can't escape its range. |
| **Rate limit** | Per-IP, per-minute. \`0\` or unset = unlimited. Default \`30\`. |
| **TTL** | Minutes until the token auto-disables. \`0\` or unset = never. After expiry, the public URL returns \`410 Gone\`. |
| **URLs** | Each token comes with a \`readUrl\` (for read / readwrite modes) and a \`writeUrl\` (for write / readwrite modes) — copy-paste-ready. |

### 2.3 · Download Token — \`expiresAt.sig\` (HMAC-SHA256)

A signed, 55-minute, per-file token that lets anyone holding the link
download one specific file — public or private. The signature IS the
credential.

| Property | Value |
|:---|:---|
| **Format** | \`?t=<expiresAt>.<hex-sig>\` appended to \`/f/:fileId\` |
| **Minted** | Auto-minted when you click 'Get link' on a file row (\`POST /v1/files/:id/link\` or \`/api/files/:id/link\`). Returned alongside the Telegram cloud URL and the proxy URL. |
| **Scope** | Exactly one file (by its internal fileId). Cannot be used to download any other file, list files, or read KV data. |
| **Lifetime** | 55 minutes (just under Telegram's ~1-hour \`getFile\` URL expiry). Never auto-refreshed — the user must click 'Get link' again after expiry. |
| **Revocation** | Revoke drops the cached Telegram URL on our side (\`POST /v1/files/:id/revoke\`). The signature itself can't be revoked, but the underlying Telegram \`getFile\` URL it points at expires on its own ~1-hour clock. |

\`\`\`http
# Click "Get link" on a file → returns a signed URL on your origin:
#   https://onyx.example.com/f/f_a1b2c3...?t=1735900000000.7e3a9f...&e=1735900000000

# Anyone with the URL can download the file — no auth header:
curl -L -o report.pdf \\
  "https://onyx.example.com/f/f_a1b2c3...?t=1735900000000.7e3a9f...&e=1735900000000"

# After 55 minutes the signature is rejected. Re-click "Get link".
\`\`\`

### 2.4 · Session — \`cloudkv-session\`

A single localStorage key on \`window\` that holds your active session
state. The server is stateless — this is the only place "you are signed in"
lives.

\`\`\`javascript
// Inspecting the session from the browser console:
const session = JSON.parse(localStorage.getItem('cloudkv-session') || '{}')
console.log(session.state)
// → {
//     apiKey: "kv_live_abc123…",
//     user: { userId: "usr_xxx", name: "Ada", plan: "free",
//            counts: { records: 4, collections: 2, apiKeys: 1, logs: 12 },
//            isAdmin: false },
//     activeView: "database",
//     activeCollection: "default",
//     useAdminMode: true
//   }

// Signing out = wipe this one key:
localStorage.removeItem('cloudkv-session')
\`\`\`

- **The API key persists in localStorage** across browser restarts. If you
  share the device, sign out when you're done. The key itself is still
  valid on the server until you revoke it from the API Keys tab.

---

## 3 · Features (thirteen dashboard tabs)

Thirteen dashboard tabs, each a real feature — not a placeholder. The icons
match the sidebar exactly.

| Tab | What it does |
|:---|:---|
| **Dashboard** | Landing page: welcome header, four stat cards (records / collections / files / API keys), a 7-day activity area chart, recent records list, and a quick-jump launcher. |
| **Database** | A spreadsheet-style IDE for your key-value data. Browse every record in the active collection, expand JSON cells, edit values inline, create new keys with auto-typing (string / number / boolean / JSON), and delete with a confirmation. Auto-refreshes in real time when other clients mutate a key — the row updates without a reload. |
| **Collections** | Group keys into named collections (\`default\`, \`cache\`, \`metrics\`, …). Create, rename, and delete whole collections in one action — deleting a collection also wipes every record inside it and mirrors the deletion to Telegram. |
| **Cloud Storage** | A drag-and-drop file manager backed by Telegram. Upload any extension up to the effective limit (50 MB cloud Bot API, or 2 GB with a self-hosted local Bot API server). Each file gets a permanent \`/f/<fileId>\` proxy URL plus a signed 55-minute download token. Toggle public/private per file; track download counts. |
| **API Keys** | Mint, name, and revoke multiple \`kv_live_…\` API keys per account. Each key is shown exactly once at creation — copy it before closing the dialog. Keys are stored as salted hashes; the plaintext is never retrievable after creation. |
| **Public Share** | Create scoped, rate-limited, expiring, revocable share tokens that wrap exactly one \`(collection, key)\` pair. Choose mode, allowed ops, max value length, incr bounds, per-IP rate limit, and TTL. Each token comes with copy-paste-ready \`readUrl\` and \`writeUrl\`. |
| **API Playground** | An interactive REST explorer: pick an endpoint, fill in the parameters, hit **Send**, and inspect the raw JSON response. Auto-injects your current API key as the Bearer header. |
| **SQL Editor** | A real SQL console that runs against virtual tables (\`records\`, \`collections\`, \`api_keys\`, \`logs\`, \`users\`) pre-filtered to your account. Run \`SELECT\` / \`INSERT\` / \`UPDATE\` / \`DELETE\` / \`CREATE\` / \`DROP\` / \`ALTER\` statements, plus create your own \`usr_*\` tables for custom schemas. 1000-row cap per result, API keys masked in output, \`⌘+Enter\` to run. |
| **Tables** | Account-scoped SQL tables with per-table access modes (\`read\` / \`write\` / \`readwrite\`). Define a schema (TEXT / INTEGER / REAL / NUMERIC / BLOB / DATETIME / BOOLEAN columns, primary keys, auto-increment, defaults, nullability), then drive full CRUD from a real database-grid UI in the dashboard, the REST API (\`/v1/tables/*\`), or the CLI (\`onyx tables\`). Each table gets a unique \`usr_<name>_<hash>\` SQLite name so two accounts can both own a \`notes\` table without colliding. Toggle the access mode at any time to lock down public-facing tables. |
| **Docs** | This in-app reference. Copy buttons on every code block, multi-language examples, and a **Copy for LLMs** button at the top to grab the whole spec for an AI assistant (it fetches this very \`/llms.txt\` file). |
| **Logs** | An append-only audit trail of every API event on your account: \`set\`, \`delete\`, \`login\`, \`apikey.create\`, \`share.create\`, file upload, \`export\`, and more. Each entry includes the action, the key/collection touched, the source (\`dashboard\` / \`cli\` / \`api\` / \`share\`), and a timestamp. Filter by action type, paginate through history. Every log entry is also mirrored into your Telegram chat as a structured message. |
| **Analytics** | Aggregate charts over your account activity: requests per day, top actions, top keys, share-token usage, file-download counts. All data is derived from the same logs table the Logs tab shows — just rolled up. |
| **Settings** | Account + storage configuration. View your \`userId\`, plan, and API-key counts. Configure your own Telegram bot (Bot Token + Chat ID) to route new KV mirrors and file uploads to your private chat instead of the shared server-side bot. Optionally set a local Bot API server URL to unlock 2 GB file uploads/downloads. Ping the bot to verify the config. |

---

## 4 · REST API (\`/v1/*\`)

Every \`/v1/*\` route (and every \`/api/dashboard/*\` route) requires the
Bearer header — except signup, public share, public file download, and
health. The same key works for the CLI, the dashboard, and any HTTP client.

\`\`\`http
Authorization: Bearer kv_live_abc123def456…
\`\`\`

### 4.1 · Key-value

| Method | Path | Purpose |
|:---|:---|:---|
| \`POST\` | \`/v1/set\` | Set / upsert a value. Body: \`{ "key", "value", "collection"? }\`. Values are auto-typed (string / number / boolean / JSON). |
| \`GET\` | \`/v1/get/:key?collection=default\` | Read a value. Returns \`{ ok, key, value, type, collection, updatedAt }\`. 404 when the key doesn't exist. |
| \`DELETE\` | \`/v1/delete/:key?collection=default\` | Remove a key + its Telegram mirror message. 404 when the key doesn't exist. |
| \`GET\` | \`/v1/list?collection=default\` | List keys in a collection. Returns \`{ ok, keys, count, collection }\`. |
| \`GET\` | \`/v1/export?collection=default\` | Dump the whole database (or one collection) as a JSON object. Non-default collections are prefixed with the collection name + a dot. |

### 4.2 · Files

| Method | Path | Purpose |
|:---|:---|:---|
| \`POST\` | \`/v1/files\` | Upload a file (multipart: \`file\`, optional \`label\`, optional \`public\`). Returns file metadata + permanent \`/f/<fileId>\` URL. |
| \`GET\` | \`/v1/files\` | List stored files. Also returns the effective \`maxFileUploadBytes\` (50 MB cloud / 2 GB local). |
| \`GET\` | \`/v1/files/:id\` | File metadata. |
| \`POST\` | \`/v1/files/:id/link\` | Mint a signed 55-minute download link. Returns \`{ url, proxyUrl, expiresAt, expiresInSec, revocable }\`. Add \`?force=1\` to bypass the 55-min server cache. |
| \`POST\` | \`/v1/files/:id/revoke\` | Drop the cached Telegram \`getFile\` URL on our side. The next \`/link\` call pulls a brand-new URL. |
| \`DELETE\` | \`/v1/files/:id\` | Permanently delete a file (record + Telegram document message). |
| \`GET\` | \`/f/:fileId?t=…&e=…\` | Public download proxy — streams bytes from Telegram through your server's origin. No auth (signature is the credential). Add \`?inline=1\` to render in-browser. |

### 4.3 · Collections

| Method | Path | Purpose |
|:---|:---|:---|
| \`GET\` | \`/v1/collections\` | List collections (with record counts). |
| \`GET\` | \`/v1/collections/:name\` | Collection detail. |

### 4.4 · Tables

Account-scoped SQL tables. Each table you create gets a unique
\`usr_<name>_<hash>\` SQLite name so two accounts can both own a \`notes\`
table without colliding. Each table has an **access mode** that controls
what the public API can do: \`read\` → GET only; \`write\` → POST / PATCH /
DELETE only; \`readwrite\` → everything. The dashboard owner can always do
everything regardless of mode — the \`/api/dashboard/tables/*\` routes have
the same shape but skip the access-mode check.

| Method | Path | Purpose |
|:---|:---|:---|
| \`GET\` | \`/v1/tables\` | List your tables (name, accessMode, rowCount, schema, timestamps). |
| \`POST\` | \`/v1/tables\` | Create a table. Body: \`{ name, columns: ColumnDef[], accessMode? }\`. \`ColumnDef = { name, type: TEXT\\|INTEGER\\|REAL\\|NUMERIC\\|BLOB\\|DATETIME\\|BOOLEAN, primary?, autoIncrement?, nullable?, defaultValue? }\`. \`accessMode\` defaults to \`readwrite\`. |
| \`GET\` | \`/v1/tables/:name\` | Describe a table — schema + rowCount + sample rows + accessMode. |
| \`PATCH\` | \`/v1/tables/:name\` | Update the access mode. Body: \`{ accessMode }\`. Takes effect on the next request. |
| \`DELETE\` | \`/v1/tables/:name\` | Drop a table (SQLite \`DROP TABLE\` + metadata delete). Cannot be undone. |
| \`GET\` | \`/v1/tables/:name/rows\` | List rows (default 100, \`?limit=\` max 1000). Honors the access mode — 403 on a write-only table. |
| \`POST\` | \`/v1/tables/:name/rows\` | Insert a row. Body: \`{ row: { col: value, … } }\`. Validates against the schema; returns the inserted row with auto-incremented / defaulted columns filled in. |
| \`PATCH\` | \`/v1/tables/:name/rows\` | Update a row by primary key. Body: \`{ pk: { col: value }, patch: { col: value } }\`. |
| \`DELETE\` | \`/v1/tables/:name/rows\` | Delete a row by primary key. Body: \`{ pk: { col: value } }\`. 404 if no row matches. |

\`\`\`bash
# Create a "tasks" table (read+write via the public API)
curl -X POST https://onyx.example.com/v1/tables \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"tasks","accessMode":"readwrite","columns":[{"name":"id","type":"INTEGER","primary":true,"autoIncrement":true},{"name":"title","type":"TEXT","nullable":false},{"name":"done","type":"BOOLEAN","defaultValue":"0"}]}'

# Insert a row
curl -X POST https://onyx.example.com/v1/tables/tasks/rows \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"row":{"title":"Buy milk","done":false}}'

# List rows
curl -H "Authorization: Bearer kv_live_…" https://onyx.example.com/v1/tables/tasks/rows
\`\`\`

> The dashboard mirrors the same shape under \`/api/dashboard/tables/*\` —
> list, create, describe, drop, mode-change, rows CRUD — but with no
> access-mode enforcement since the dashboard owner has full access. The CLI
> talks to the dashboard routes.

### 4.5 · Account & ops

| Method | Path | Purpose |
|:---|:---|:---|
| \`GET\` | \`/v1/whoami\` | Identify the current API key + user. Returns \`{ userId, apiKeyId, apiKeyName, isAdmin }\`. |
| \`GET\` | \`/v1/health\` | Service + Telegram storage status. Liveness + readiness probe. No auth. |
| \`GET\` | \`/v1/stats\` | Account statistics (records / collections / apiKeys / logs / files counts, activity by day, recent activity). |
| \`GET\` | \`/v1/logs?limit=50&action=…\` | Recent audit log entries, optionally filtered by action. |

### 4.6 · Share tokens (public surface)

| Method | Path | Purpose |
|:---|:---|:---|
| \`GET\` | \`/v1/share/:token\` | **Public** scoped read — no auth. Returns the value, type, and updatedAt for the single key the token wraps. |
| \`POST\` | \`/v1/write/:token\` | **Public** scoped write — no auth. Body: \`{ "op": "set"|"incr"|"append", "value"?, "amount"? }\`. Honors \`allowedOps\`, \`maxValueLength\`, \`incrMin/incrMax\`, and the per-IP rate limit. |
| \`POST\` | \`/api/dashboard/share-tokens\` | Create a share token (auth required). Body: \`{ collection?, key, mode, label?, ttlMinutes?, rateLimitPerMin?, allowedOps?, maxValueLength?, incrMin?, incrMax? }\`. |
| \`GET\` | \`/api/dashboard/share-tokens\` | List your share tokens (auth required). |
| \`DELETE\` | \`/api/dashboard/share-tokens/:id\` | Revoke a share token instantly (auth required). The public URL returns 404 on the next request. |

### 4.7 · Advanced surface (\`/api/v1/*\`)

A Supabase-style advanced surface lives under \`/api/v1/*\` (note the \`/api\`
prefix, distinct from the basic \`/v1/*\` surface). All routes require the
Bearer API key and are scoped to the authenticated user.

| Method | Path | Purpose |
|:---|:---|:---|
| \`GET\` | \`/api/v1/views\` | List named views (projections over a collection). Create with \`POST /api/v1/views { name, collection, projection, filter? }\`. |
| \`GET\` | \`/api/v1/views/:name\` | Execute a stored view — applies its substring filter on the key and projects the requested columns. |
| \`GET\` | \`/api/v1/matviews\` | List materialized views (pre-computed aggregations cached as JSON). Create with \`POST /api/v1/matviews { name, query }\`. Refresh-all with \`POST /api/v1/matviews { action: "refresh_all" }\`. |
| \`GET\` | \`/api/v1/matviews/:name\` | O(1) read of the cached aggregation result. \`POST\` to refresh, \`DELETE\` to drop. |
| \`POST\` | \`/api/v1/functions\` | Create a server-side function. Body: \`{ name, code }\`. Runs in a \`new Function("ctx", code)\` sandbox with \`{ record, db, user }\` — \`db\` is read-only and user-scoped. 5s timeout, syntax-checked at create. |
| \`POST\` | \`/api/v1/functions/:name\` | Test-invoke a stored function with the supplied \`ctx\` body. |
| \`POST\` | \`/api/v1/rpc/:name\` | Built-in RPC: \`count_records\`, \`sum { key }\`, \`aggregate { collection, type }\`, \`search { query, collection?, limit? }\`, \`touch { key, value, collection? }\`. All user-scoped. |
| \`POST\` | \`/api/v1/graphql\` | Minimal hand-rolled GraphQL endpoint (no Apollo/graphql deps). Queries for \`records\`, \`collections\`, \`apiKeys\`, \`logs\`, \`me\` — all user-scoped. Args + variables supported on \`records(limit, collection)\` and \`logs(limit, action)\`. Standard \`{ data, errors }\` response. |

### 4.8 · Admin routes (\`/api/admin/*\`)

Require \`Authorization: Bearer onyxbase_…\`.

| Method | Path | Purpose |
|:---|:---|:---|
| \`GET\` | \`/api/admin/whoami\` | Confirm admin identity + bootstrap flag. |
| \`GET\` | \`/api/admin/users\` | List ALL users with stats + global stats. |
| \`GET\` | \`/api/admin/users/:id\` | Per-user detail: collections, records, files, API keys. |
| \`GET\` | \`/api/admin/files\` | List ALL files across ALL users with owner info. |
| \`POST\` | \`/api/admin/files/:id/link\` | Admin override — mint Telegram URL for ANY user's file (\`?force=1\` bypasses cache). |
| \`DELETE\` | \`/api/admin/files/:id/link\` | Admin override — revoke cached URL for ANY user's file. |
| \`POST\` | \`/api/admin/promote\` | Promote a \`kv_live_\` key to an \`onyxbase_\` key (body: \`{kvLiveKey, label}\`). |
| \`GET\` | \`/api/admin/admins\` | List all admin keys (bootstrap flagged). |
| \`DELETE\` | \`/api/admin/admins?id=\` | Revoke an admin key (bootstrap cannot be revoked → 409). |
| \`GET · POST\` | \`/api/admin/branches\` | List / create DB branches (snapshot SQLite + JSON cache under a named branch). |
| \`DELETE\` | \`/api/admin/branches/:name\` | Drop a branch (delete the snapshot, keep the live DB). |
| \`GET · POST\` | \`/api/admin/network\` | Get / mutate the runtime IP allowlist (IPv4 CIDR matching; empty = open). |

---

## 5 · Quick start in any language

The five core operations below — set, get, upload, create a table, insert a
row — cover ~90% of what you'll do. Each sample uses
\`https://onyx.example.com\` and \`kv_live_YOUR_API_KEY\` as literal
placeholders so you can copy, swap, and run.

### 5.1 · Set a value — \`POST /v1/set\`

\`\`\`bash
# curl
curl -X POST https://onyx.example.com/v1/set \\
  -H "Authorization: Bearer kv_live_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"greeting","value":"hello world"}'
\`\`\`

\`\`\`javascript
// Node
const r = await fetch("https://onyx.example.com/v1/set", {
  method: "POST",
  headers: {
    Authorization: "Bearer kv_live_YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ key: "greeting", value: "hello world" }),
});
console.log(await r.json());
\`\`\`

\`\`\`python
# Python
import requests
r = requests.post(
    "https://onyx.example.com/v1/set",
    headers={"Authorization": "Bearer kv_live_YOUR_API_KEY"},
    json={"key": "greeting", "value": "hello world"},
)
print(r.json())
\`\`\`

\`\`\`go
// Go
package main

import ("bytes"; "fmt"; "net/http")

func main() {
    body := []byte(\`{"key":"greeting","value":"hello world"}\`)
    req, _ := http.NewRequest("POST", "https://onyx.example.com/v1/set", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer kv_live_YOUR_API_KEY")
    req.Header.Set("Content-Type", "application/json")
    r, _ := http.DefaultClient.Do(req)
    defer r.Body.Close()
    fmt.Println(r.Status)
}
\`\`\`

\`\`\`rust
// Rust
use reqwest::blocking::Client;

fn main() -> reqwest::Result<()> {
    let c = Client::new();
    let r = c.post("https://onyx.example.com/v1/set")
        .bearer_auth("kv_live_YOUR_API_KEY")
        .json(&serde_json::json!({"key":"greeting","value":"hello world"}))
        .send()?;
    println!("{}", r.status());
    Ok(())
}
\`\`\`

\`\`\`php
<?php
// PHP
$ch = curl_init("https://onyx.example.com/v1/set");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer kv_live_YOUR_API_KEY",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode(["key" => "greeting", "value" => "hello world"]),
]);
echo curl_exec($ch), "\\n";
\`\`\`

### 5.2 · Get a value — \`GET /v1/get/:key\`

\`\`\`bash
curl -H "Authorization: Bearer kv_live_YOUR_API_KEY" \\
  https://onyx.example.com/v1/get/greeting
\`\`\`

\`\`\`javascript
const r = await fetch("https://onyx.example.com/v1/get/greeting", {
  headers: { Authorization: "Bearer kv_live_YOUR_API_KEY" },
});
console.log(await r.json());
\`\`\`

\`\`\`python
import requests
r = requests.get(
    "https://onyx.example.com/v1/get/greeting",
    headers={"Authorization": "Bearer kv_live_YOUR_API_KEY"},
)
print(r.json())
\`\`\`

### 5.3 · Upload a file — \`POST /v1/files\`

\`\`\`bash
curl -X POST https://onyx.example.com/v1/files \\
  -H "Authorization: Bearer kv_live_YOUR_API_KEY" \\
  -F "file=@./report.pdf" \\
  -F "label=Q3 report"
\`\`\`

\`\`\`javascript
const fd = new FormData();
fd.append("file", fileInput.files[0]);
fd.append("label", "Q3 report");
const r = await fetch("https://onyx.example.com/v1/files", {
  method: "POST",
  headers: { Authorization: "Bearer kv_live_YOUR_API_KEY" },
  body: fd,
});
console.log(await r.json());
\`\`\`

\`\`\`python
import requests
r = requests.post(
    "https://onyx.example.com/v1/files",
    headers={"Authorization": "Bearer kv_live_YOUR_API_KEY"},
    files={"file": open("report.pdf", "rb")},
    data={"label": "Q3 report"},
)
print(r.json())
\`\`\`

### 5.4 · Create a table — \`POST /v1/tables\`

\`\`\`bash
curl -X POST https://onyx.example.com/v1/tables \\
  -H "Authorization: Bearer kv_live_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"tasks","accessMode":"readwrite","columns":[
        {"name":"id","type":"INTEGER","primary":true,"autoIncrement":true},
        {"name":"title","type":"TEXT","nullable":false},
        {"name":"done","type":"BOOLEAN","defaultValue":"0"}
      ]}'
\`\`\`

\`\`\`javascript
const r = await fetch("https://onyx.example.com/v1/tables", {
  method: "POST",
  headers: {
    Authorization: "Bearer kv_live_YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "tasks",
    accessMode: "readwrite",
    columns: [
      { name: "id", type: "INTEGER", primary: true, autoIncrement: true },
      { name: "title", type: "TEXT", nullable: false },
      { name: "done", type: "BOOLEAN", defaultValue: "0" },
    ],
  }),
});
console.log(await r.json());
\`\`\`

\`\`\`python
import requests
r = requests.post(
    "https://onyx.example.com/v1/tables",
    headers={"Authorization": "Bearer kv_live_YOUR_API_KEY"},
    json={
        "name": "tasks",
        "accessMode": "readwrite",
        "columns": [
            {"name": "id", "type": "INTEGER", "primary": True, "autoIncrement": True},
            {"name": "title", "type": "TEXT", "nullable": False},
            {"name": "done", "type": "BOOLEAN", "defaultValue": "0"},
        ],
    },
)
print(r.json())
\`\`\`

### 5.5 · Insert a row — \`POST /v1/tables/:name/rows\`

\`\`\`bash
curl -X POST https://onyx.example.com/v1/tables/tasks/rows \\
  -H "Authorization: Bearer kv_live_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"row":{"title":"Buy milk","done":false}}'
\`\`\`

\`\`\`javascript
const r = await fetch("https://onyx.example.com/v1/tables/tasks/rows", {
  method: "POST",
  headers: {
    Authorization: "Bearer kv_live_YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ row: { title: "Buy milk", done: false } }),
});
console.log(await r.json());
\`\`\`

\`\`\`python
import requests
r = requests.post(
    "https://onyx.example.com/v1/tables/tasks/rows",
    headers={"Authorization": "Bearer kv_live_YOUR_API_KEY"},
    json={"row": {"title": "Buy milk", "done": False}},
)
print(r.json())
\`\`\`

---

## 6 · CLI (\`onyx\`)

A zero-dependency Node.js tool. Install it globally, point it at your server
once, and use it from any terminal. Config is stored at
\`~/.onyx/config.json\` with 0600 permissions. \`get\` and \`list\` keep
stdout clean for piping; type hints go to stderr.

\`\`\`bash
# Install (zero npm dependencies)
npm i -g onyx-base

# One-time setup: point the CLI at this server
export ONYX_URL=https://onyx.example.com

# Auth
onyx login --name "Ada" --email ada@example.com   # create account → returns kv_live_…
onyx login --key kv_live_…                          # connect an existing account
onyx whoami                                         # verify credentials + show user info
onyx logout                                         # clear ~/.onyx/config.json

# Key-value
onyx set greeting "hello world"                     # auto-typed (string)
onyx set coins 500                                  # auto-typed (number)
onyx set premium true                               # auto-typed (boolean)
onyx set user '{"name":"alice","age":30}'           # auto-typed (JSON)
onyx set counter 1 --collection metrics             # write to a non-default collection
onyx get greeting                                   # → "hello world"  (stdout, pipe-friendly)
onyx list                                           # keys only (stdout)
onyx list -v                                        # KEY/TYPE/COLLECTION table (stderr)
onyx delete coins                                   # remove a key
onyx export --output backup.json                    # dump the whole DB as JSON

# Files
onyx upload ./report.pdf --label "Q3 report"        # upload (50 MB cloud / 2 GB local)
onyx files                                          # list stored files
onyx download f_abc123 ./out.pdf                    # download by fileId
onyx file-link f_abc123                             # mint a fresh ~1h download link
onyx file-revoke f_abc123                           # drop the cached link
onyx file-delete f_abc123                           # permanently delete a file

# Tables (account-scoped SQL tables; alias: tbl)
onyx tables                                          # list your tables (alias: onyx tbl)
onyx tables create tasks --columns "id:INTEGER:pk:ai,title:TEXT:notnull,body:TEXT" --access rw
onyx tables describe tasks                           # schema + sample rows
onyx tables rows tasks                               # list rows (default 100)
onyx tables insert tasks --data '{"title":"Buy milk","done":false}'
onyx tables update tasks --pk '{"id":1}' --data '{"done":true}'
onyx tables delete tasks --pk '{"id":1}' --yes
onyx tables drop tasks --yes                         # drop the whole table
onyx tables mode tasks r                             # change access mode (r=read, w=write, rw=readwrite)

# Collections
onyx collections                     # list collections (+ record counts)
onyx collections --create cache      # create a new collection

# Share tokens
onyx share --key visits --mode read --ttl 3600   # mint a scoped share token
onyx share --list                                # list your share tokens
onyx share --revoke <tokenId>                     # revoke one

# Telemetry
onyx whoami                        # current API key + user info
onyx stats                         # account statistics
onyx logs --limit 50               # recent audit log entries

# Settings
onyx telegram-config --show        # show your current storage backend
onyx telegram-config --token "<bot_token>" --chat "<chat_id>"  # switch to BYOB
onyx api-keys                      # list / rotate / revoke your API keys

# Admin (requires an onyxbase_ key)
onyx admin whoami                  # confirm admin identity
onyx admin users                   # list all users + global stats
onyx admin user <userId>           # full per-user detail (kv, files, api keys)
onyx admin files                   # list ALL files across ALL users
onyx admin promote kv_live_abc123  # promote a regular user to admin
onyx admin admins                  # list all admin keys
onyx admin revoke onyxbase_xxx     # revoke a promoted admin key
\`\`\`

### Column-spec mini-DSL

The \`--columns\` argument to \`onyx tables create\` takes a comma-separated
list of column specs, each in the form:

\`\`\`
name:TYPE[:pk][:ai][:notnull][:default=VALUE]

  name      any SQL-safe identifier (letters, digits, _)
  TYPE      INTEGER | TEXT | REAL | NUMERIC | BLOB | DATETIME | BOOLEAN
  pk        marks the column as PRIMARY KEY
  ai        AUTOINCREMENT (implies INTEGER + pk)
  notnull   adds NOT NULL
  default=… sets a DEFAULT value (colons inside the value are respected if the
            whole spec is quoted, e.g. "ts:DATETIME:default=2024-01-01 12:00:00")

Examples:
  "id:INTEGER:pk:ai,title:TEXT:notnull,body:TEXT"
  "id:INTEGER:pk:ai,email:TEXT:notnull,created:DATETIME:default=now"
  "k:TEXT:pk,v:TEXT,tags:TEXT"
\`\`\`

The CLI parses this spec client-side and POSTs the same
\`{ name, columns: ColumnDef[], accessMode }\` body the REST API expects.

---

## 7 · Realtime (Socket.io)

The dashboard auto-updates without polling. A Socket.io mini-service (port
3003) fans \`record:changed\` events out to every connected browser whenever
a key is set, deleted, or mutated via a share token. The Database tab's row
updates in place; the Logs tab gets a new entry; the Dashboard stat cards
refresh. No refresh button, no \`setInterval\`, no stale data.

### Connection model

The browser opens one Socket.io connection to the realtime service (routed
through the gateway as \`io("/?XTransformPort=3003")\`). The service
subscribes to per-userId rooms; when an API write happens, the Next.js core
emits an event that the realtime service broadcasts to everyone in that
user's room. The connection auto-reconnects on drop; a small green dot in
the sidebar shows live status.

\`\`\`javascript
// The event payload looks like this:
{
  type: 'record:changed',
  owner: 'usr_xxxxx',
  collection: 'default',
  key: 'coins',
  value: 500,
  previous: 499,
  op: 'set',                  // 'set' | 'delete' | 'incr' | 'append'
  source: 'cli',              // 'dashboard' | 'cli' | 'api' | 'share'
  ts: 1735900000000
}
\`\`\`

Open the dashboard in two browser tabs, then run \`onyx set coins 500\` in
your terminal. Both tabs update within milliseconds — no polling, no manual
refresh. This is what makes the dashboard feel like a live database IDE
instead of a static admin panel.

---

## 8 · Telegram durability

Telegram IS the durable substrate. Every mutation — set, delete, api-key
create/revoke, collection create/delete, file upload, share token
create/revoke, signup, login — is mirrored into your private Telegram chat
as a structured message. That mirror is the durable backup. The in-memory
store + JSON-on-disk cache are the fast read path; if they're wiped, the
chat still has the full history and the platform can rebuild from it.

### Mirroring model

Each KV record is a single message in the chat. Updates **edit** the
message in place (so the chat doesn't grow unboundedly on every write);
deletes remove the message. Identity mutations (signup, api-key create)
update a **pinned manifest message** at the top of the chat — a small JSON
document that ties your \`userId\` to your API key hashes and collection
list.

### Self-healing after a full reset

1. The server's local SQLite + JSON cache are wiped (operator action,
   accident, or a fresh deploy).
2. The next request arrives with a valid \`Authorization: Bearer
   kv_live_…\` header.
3. Cache-miss on the API key → the auth layer fetches the **pinned identity
   manifest** from Telegram.
4. The manifest lists every \`userId\` → \`apiKeyHash\` → \`collections\` →
   \`records\` mapping for that chat.
5. Onyx Base rehydrates the user row, the API key (as a hash), the
   collections, and (lazily, on read) every record back into the local
   store.
6. The original request is retried — transparently to the caller.

### File storage routing

Uploads **automatically** use the server-side Telegram bot when no custom
config is set up. Set up your own bot in Settings to route new uploads to
your private chat. Each file remembers which backend holds it, so downloads
and deletes always hit the correct bot — even if you change config later.

#### On-demand download links (Telegram's 1-hour rule)

Telegram revokes every \`getFile\` download URL after **~1 hour**. Onyx
Base respects that limit instead of fighting it:

- Every file row has a **Get link** button. Tap it → the backend asks
  Telegram's \`getFile\` API for a fresh **Telegram cloud URL**
  (\`https://api.telegram.org/file/bot…/…\`) and returns it directly.
  Telegram revokes this URL after ~1 hour — that's Telegram's built-in
  behaviour, not ours.
- A live countdown shows when the link expires. After expiry, tap
  **Refresh** to pull a brand-new URL from Telegram.
- **Revoke** drops the cached URL from our server immediately and marks
  the file's link as revoked. The next **Get link** call mints a brand-new
  URL via a fresh \`getFile\` call. (Note: Telegram's own URL remains
  valid until its natural ~1-hour expiry — we can't force Telegram to
  revoke it sooner — but we no longer cache or re-serve it on our side.)
- Links are fetched **only on your tap**, never automatically — so the
  Telegram API is never spammed. A 55-minute server-side cache means even
  repeated calls for the same file make at most one \`getFile\` call per
  hour.
- A **proxy URL** on your server's origin (\`/f/<fileId>\`) is also
  returned as a fallback — permanent for public files, works worldwide,
  and never exposes the Telegram bot token.

### File limits (Telegram Bot API, accurate)

- **Upload via cloud Bot API** (\`sendDocument\` / \`sendVideo\` / …):
  **50 MB** max per file.
- **Download via \`getFile\`** (cloud): **20 MB** max — \`getFile\` only
  returns a \`file_path\` for files ≤ 20 MB.
- **2 GB upload + 2 GB download**: only with a self-hosted [Local Bot API
  Server](https://github.com/tdlib/telegram-bot-api). **Onyx Base does NOT
  currently support this** — roadmap (operator-configurable
  \`TELEGRAM_BOT_API_URL\`).

The 2 GB ceiling is enforced app-side either way; without a local Bot API
server, uploads > 50 MB and downloads > 20 MB fail at the Telegram layer.

### Bring Your Own Bot (recommended for production)

Onyx Base works out of the box with a server-side shared bot — but for
anything beyond tinkering, **bring your own bot**. It costs nothing, takes
30 seconds, and gives you dramatically more control:

- **Full control.** You own the bot token. Revoke, rotate, or replace it
  anytime without coordination.
- **Private storage.** Every KV mirror message, every uploaded file, and
  the pinned identity manifest land in **your** Telegram chat — not a
  shared pool that other tenants can read.
- **No shared bandwidth.** The default server bot's \`getFile\` quota is
  shared across every user on the instance. Your own bot has its own
  dedicated quota.
- **No shared rate limits.** Telegram throttles per-bot, so the busier
  the shared bot gets, the slower everyone's downloads become. With your
  own bot, you're the only tenant.
- **Your data stays with you.** Stop using Onyx Base tomorrow and your
  full database is still sitting in your Telegram chat, fully readable.
- **Up to 2 GB per file (with a local Bot API server).**

#### How to set it up

1. Create a bot via [@BotFather](https://t.me/BotFather) → copy the **Bot
   Token**.
2. Create a channel or group, add the bot as an **administrator**.
3. Forward any message from that chat to [@userinfobot](https://t.me/userinfobot)
   to get the **Chat ID** (it looks like \`-1001234567890\`).
4. In the dashboard → **Settings → Storage backend**, paste the Chat ID
   and Bot Token, and save.

   Or from the CLI:

   \`\`\`bash
   onyx telegram-config --token "<bot_token>" --chat "<chat_id>"
   \`\`\`

From that point, new uploads and KV mirrors go to **your** bot. Existing
files stay on whichever backend they were uploaded to (each file remembers
its backend), so downloads and deletes keep working seamlessly.

> The server's default bot is **shared** and intended for evaluation /
> demos only. For production, **bring your own bot.**

---

## 9 · Authentication & recovery

Your API key (\`kv_live_…\`) is the only credential needed for all data
operations. A separate email + password exists solely for key recovery.
Every identity mutation is mirrored to the Telegram pinned manifest, so
the platform can self-heal after a full reset.

- Sign in via API key **or** email + password → dashboard.
- Lose your key? Recover it from the Telegram pinned manifest.
- Disposable-email signups are blocked at the door.

### Admin system

Onyx Base ships with a built-in admin role that can see and manage **every
user's data** on the instance — useful for self-hosted operators, support
workflows, and disaster recovery. Admins use a separate key prefix
(\`onyxbase_…\`) that unlocks a dedicated admin console alongside the
regular dashboard.

The bootstrap admin key is set in \`.env\`:

\`\`\`bash
# .env (NEVER commit this file — it's gitignored)
BOOTSTRAP_ADMIN_KEY=onyxbase_<your-own-long-random-string>
\`\`\`

Generate one with \`openssl rand -hex 16\` and prefix it with \`onyxbase_\`.
Sign in with this key (web UI or CLI) to enter the **Admin Dashboard** — a
separate console that shows every user, their collections, keyvalues,
files, and API keys. The bootstrap key cannot be revoked or rotated from
the UI; rotate it by changing the env var and redeploying.

Promote a regular user to admin:

\`\`\`bash
onyx admin promote kv_live_abc123def456 --label "Ada (ops)"
# or via curl:
curl -X POST https://onyx.example.com/api/admin/promote \\
  -H "Authorization: Bearer $BOOTSTRAP_ADMIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"kvLiveKey":"kv_live_abc123def456","label":"Ada (ops)"}'
# → { "adminKey": "onyxbase_a1b2c3d4e5f6…", "label": "Ada (ops)" }
\`\`\`

---

## 10 · Storage model

- **SQLite** (embedded, via Prisma) — fast local index, instant reads,
  single-node.
- **Telegram** — durable backup. Every record is mirrored as a structured
  message in the user's chat (their own bot or the server-side shared
  bot). Append-only, replayable.
- **Identity manifest** — a pinned Telegram message recording
  \`user → API keys → collections → records\`; re-pinned after every write
  so the platform self-heals after a full reset.
- **Realtime** — Socket.io on port 3003 pushes \`record:changed\` events;
  no polling.

### Tech stack layers

\`\`\`
Telegram (durable storage)
   ↓
Next.js API routes (logic)
   ↓
Prisma + SQLite (fast index)
   ↓
React + shadcn/ui (dashboard)
\`\`\`

---

## 11 · Feature inventory (Supabase-style mapping)

- **Security** — RLS: per-userId data isolation on every query
  (Equivalent). Policies: API-key scoping + share-token scope field
  (Equivalent). JWT verify: signed download tokens, HMAC-SHA256
  constant-time (Equivalent). SSL: HTTPS at Caddy gateway + HSTS
  (Equivalent). Vault: all secrets in \`.env\`, gitignored (Equivalent).
  Audit logs: every write/login/admin action in \`logs\` table + Telegram
  mirror (Implemented). Network restrictions / IP allow-lists: Implemented
  (\`IP_ALLOWLIST\` env + runtime allowlist via \`POST /api/admin/network\`;
  IPv4 CIDR matching; enforced on every \`/v1/*\` and \`/api/*\` request;
  empty = open).
- **Database** — Managed PostgreSQL: N/A (we use SQLite + Telegram). PITR:
  Equivalent (Telegram mirror is append-only, replayable). Backups:
  Implemented (every record mirrored; manifest pinned). SQL editor:
  Implemented (read+write \`SELECT\`/\`INSERT\`/\`UPDATE\`/\`DELETE\`/\`CREATE\`/\`DROP\`/\`ALTER\`
  against user-scoped virtual tables — records, collections, api_keys,
  logs, users — 1000-row cap, API keys masked, custom \`usr_*\` tables
  allowed). Triggers: Equivalent (event system fires \`record:changed\` via
  WebSocket + Telegram mirror). Branching: Implemented (admin
  \`POST /api/admin/branches\` snapshots SQLite + JSON cache; restore +
  delete supported). Functions (PL/pgSQL equivalent): Implemented
  (\`POST /api/v1/functions\` stores JS code; \`POST /api/v1/functions/:name\`
  test-invokes in a \`new Function(ctx, code)\` sandbox with
  \`{ record, db, user }\`; 5s timeout; \`db\` is read-only + user-scoped).
  Views: Implemented (\`POST /api/v1/views { name, collection, projection,
  filter? }\`; \`GET /api/v1/views/:name\` executes the projection).
  Materialised views: Implemented (\`POST /api/v1/matviews { name, query }\`
  runs + caches the result; \`GET\` reads O(1); \`POST\` refreshes;
  refresh-all via \`POST /api/v1/matviews { action: "refresh_all" }\`).
  Read replicas / connection pooling / FDW: N/A (embedded SQLite).
- **Data API** — REST API: Implemented (\`/v1/*\`). Auto-generated RESTful
  API: every collection auto-exposes \`/v1/set\` \`/v1/get\` \`/v1/delete\`
  \`/v1/list\` (Implemented). Realtime API: WebSocket on :3003 pushes
  \`record:changed\` (Implemented). API keys: \`kv_live_*\`, per-user,
  revocable, named (Implemented). JWT auth: signed download tokens
  (Equivalent). Automatic RLS-by-default: every new collection is
  immediately accessible via \`/v1/*\` with per-userId isolation
  (Equivalent). GraphQL: Implemented (\`POST /api/v1/graphql\` — minimal
  subset: records, collections, apiKeys, logs, me; user-scoped;
  \`{ data, errors }\` response). OpenAPI docs: Implemented
  (\`GET /api/openapi.json\` + \`GET /api/docs\` Swagger UI). RPC:
  Implemented (\`POST /api/v1/rpc/:name\` — \`count_records\`, \`sum\`,
  \`aggregate\`, \`search\`, \`touch\`).

---

## 12 · Roadmap — 25 more Telegram-powered features

The features below are **ideas only** — none of them are implemented yet.
Each one leans on a unique property of the Telegram Bot API (chat-as-
storage, message-edit, pinned messages, file attachments, channels, topic
threads, replies, inline keyboards, callback queries, \`forwardMessage\`,
\`copyMessage\`, \`editMessageText\`, \`setMyCommands\`, Telegram Passport,
message scheduling, polls, stickers, etc.). They are grouped into five
categories of five.

### Storage models

1. **Channel-as-collection** — each Telegram channel maps 1-to-1 to a KV
   collection; posting a message in the channel creates a record, deleting
   the message drops the key. Channels become first-class, externally-
   addressable namespaces.
2. **Topic-thread collections** — in a supergroup with topics enabled,
   each topic thread is a sub-collection. One chat can host dozens of
   parallel collections, partitioned by \`topic_id\`, with per-topic ACLs
   inherited from the group.
3. **Message-thread transactions** — group a multi-key transaction as a
   reply thread: each reply is one mutated key, and the thread closes
   atomically when the parent message is edited to \`committed\`. Rollback
   = deleting the thread.
4. **Pinned-message indexes** — maintain B-tree-like secondary indexes as
   pinned messages — one pinned JSON document per indexed column, re-pinned
   on every write. Lookups become O(1) chat reads instead of full scans.
5. **File-dedup via \`file_unique_id\`** — Telegram assigns every uploaded
   file a globally-unique \`file_unique_id\`. Detect duplicate uploads by
   it and dedupe — store one Telegram document, reference-count the rest.

### Bot interactions

6. **Telegram-native CRUD bot** — reply to a KV mirror message in the chat
   to update the corresponding record; the bot parses the reply and
   mutates the store. Edit a mirror message to overwrite, delete it to
   drop the key.
7. **Bot-command SQL REPL** — \`setMyCommands\` registers \`/sql\`,
   \`/get\`, \`/set\`, \`/list\`. Run \`/sql SELECT * FROM tasks WHERE
   done=0\` directly in the chat; the bot returns the result as a
   formatted message or CSV attachment.
8. **Inline-keyboard TTL controls** — every mirror message ships with
   inline buttons: \`+1h\`, \`+1d\`, \`revoke\`. Tapping a button fires a
   \`callback_query\` that adjusts the record's TTL without an API call.
9. **Sticker-as-boolean toggle** — react to a mirror message with a 👍
   sticker to flip a boolean key true, 👎 to flip it false. The bot
   watches \`message_reactions\` and mutates the store in response.
10. **Webhook-from-reply** — reply \`retry\` to a failed-write mirror
    message to replay the operation. Reply \`rollback\` to undo. The
    reply chain becomes a per-record operations console.

### Replication & backup

11. **Cross-chat replication** — mirror the same record to N Telegram
    chats for multi-region redundancy. Reads fail over to the next chat on
    a 404; writes fan out and reconcile via the pinned manifest.
12. **Bot-2-bot hot backup** — a second bot mirrors the first bot's chat
    via \`getUpdates\` + \`forwardMessage\`, giving a hot-standby that can
    take over instantly if the primary bot token is compromised or
    revoked.
13. **Message-edit diff log** — every KV edit's Telegram mirror keeps the
    previous value as a reply in the thread — free, append-only version
    history with no extra storage cost.
14. **Channel-topic partitions** — shard a hot collection across multiple
    topics in a channel for write throughput. The bot hashes the key →
    \`topic_id\`, so writes spread across topics instead of contending on
    one.
15. **Forwarded-message provenance** — when a record is copied from
    another chat, store the original \`chat_id\` + \`message_id\` as
    provenance metadata — giving every value an audit trail back to its
    source.

### Developer experience

16. **Telegram-login-widget sessions** — replace the email+password
    recovery flow with Telegram's login widget — sign in with one tap, no
    OTP, no password to forget. The bot's signed identity proof becomes
    the session.
17. **Chat-as-a-queue** — use a dedicated chat as a FIFO work queue:
    producers send messages, consumers poll via \`getUpdates\` with a
    long-poll offset. \`ack\` = \`deleteMessage\`, \`retry\` = \`editMessage\`
    + repost.
18. **Scheduled writes via message scheduling** — Telegram's
    \`schedule_message\` becomes a delayed KV write: schedule a message
    24h out, and the bot applies it as a \`set\` when it fires. Cron, but
    stored in Telegram.
19. **QR-code value replies** — after every \`set\`, the bot replies with
    a QR code image of the value — scan-to-share on mobile without
    copy-paste. Optional per-collection toggle.
20. **Voice-note transcriptions** — upload a voice message; the bot
    transcribes it via Whisper and stores the text as the value. Audio +
    transcript both live in Telegram, retrievable as a paired album.

### Integrations

21. **Telegram-passport-backed auth** — use Telegram Passport for
    KYC-verified accounts — the bot requests identity documents, the user
    approves via Telegram's native UI, and the verified status is mirrored
    to the manifest.
22. **Poll-backed aggregations** — a Telegram poll mirrors a numeric KV
    counter; votes update it via \`getUpdates\`. Closing the poll freezes
    the counter, exporting the result as a snapshot matview.
23. **Album-as-document** — group multiple file uploads as a single
    logical document via Telegram's media-album feature. One record, N
    attachments, atomic download.
24. **Message-reply-graph for FKs** — model foreign-key relationships as
    reply chains — a child record's mirror message replies to its
    parent's. Cascading deletes = walk the reply tree with
    \`deleteMessage\`.
25. **Animated-avatar config reflection** — store user profile config
    (theme, avatar, status text) as KV; the bot's own avatar and bio
    reflect the live state, so the bot's profile is a live status board.

> None of these are implemented yet — they are design notes to show how
> much further Telegram-as-a-database can go.

---

## 13 · Quick start (deployment)

\`\`\`bash
# 1. Install & run the web app (self-host)
bun install
bun run db:push     # create the SQLite schema
bun run dev         # starts on http://localhost:3000 locally

# 2. Create an account (web UI, CLI, or curl) — use your deployed URL in production
curl -X POST https://onyx.example.com/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Ada","email":"ada@example.com","password":"secret123"}'
# → { "apiKey": "kv_live_…" }

# 3. Store and read your first value
curl -X POST https://onyx.example.com/v1/set \\
  -H "Authorization: Bearer kv_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"greeting","value":"hello world"}'

curl https://onyx.example.com/v1/get/greeting \\
  -H "Authorization: Bearer kv_live_…"
# → { "value": "hello world", "type": "string" }

# 4. Upload a file (any extension, up to 50 MB via cloud Bot API)
curl -X POST https://onyx.example.com/v1/files \\
  -H "Authorization: Bearer kv_live_…" \\
  -F "file=@./report.pdf"
# → { "file": { "id": "…", "fileId": "f_…", "storageMode": "server", "isPublic": true } }

# 5. Mint a fresh Telegram cloud download link (revoked by Telegram after ~1h)
curl -X POST https://onyx.example.com/v1/files/<id>/link \\
  -H "Authorization: Bearer kv_live_…"
# → { "url": "https://api.telegram.org/file/bot…/…",
#     "proxyUrl": "https://onyx.example.com/f/f_…",
#     "expiresAt": 1735900000000, "expiresInSec": 3300, "revocable": true }
\`\`\`

---

## 14 · Project layout

\`\`\`
src/
├── app/
│   ├── api/            # dashboard + admin API routes (auth, files, share-tokens, /api/admin/*, …)
│   ├── v1/             # public REST API (kv, files, share, write)
│   ├── f/[id]/         # public file download proxy
│   ├── admin/          # /admin direct-entry route to the admin console
│   └── page.tsx        # the single user-visible route
├── components/
│   ├── dashboard/      # storage, share, docs, playground, settings, …
│   ├── admin/          # admin console (cross-user management)
│   └── ui/             # shadcn/ui component set
├── lib/
│   ├── data-store.ts   # the in-memory + disk store, Telegram sync, file CRUD, admin keys
│   ├── telegram.ts     # sendKvMessage, sendDocumentFile, pinned manifest…
│   ├── auth.ts         # Bearer auth + getPublicOrigin + auto-rehydrate + admin detection
│   ├── kv.ts           # ensureCollection, setKey, getKey, logAction…
│   └── api.ts          # typed client used by the dashboard
mini-services/
└── realtime/           # Socket.io service (port 3003) — record:changed events
cli/
└── index.js            # the zero-dependency \`onyx\` CLI
prisma/
└── schema.prisma       # User, ApiKey, Collection, Record, Log…
\`\`\`

---

## 15 · More info

- Full endpoint references with cURL / JS / Python / CLI examples: in-app
  **Docs** tab — including the **Single page** tab which renders this very
  file end-to-end inside the dashboard.
- The **Copy for LLMs** button at the top of the Docs tab fetches this
  file and writes it to your clipboard for pasting into any AI assistant.
- Telegram Bot API file limits: <https://core.telegram.org/bots/api#sending-files>
- Local Bot API server: <https://github.com/tdlib/telegram-bot-api>
- llms.txt convention: <https://llmstxt.org>
- OpenAPI 3.0 spec: \`GET /api/openapi.json\` · Swagger UI: \`GET /api/docs\`

---

## License

MIT — build on it, ship it, make it yours.

Built with Next.js 16 · Prisma · Socket.io · Telegram · shadcn/ui.
Palette: Claude-inspired warm clay on cream.
`

export async function GET() {
  return new NextResponse(LLMS_TXT, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
