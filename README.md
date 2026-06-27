<div align="center">

<img src="public/logo.png" width="128" height="128" alt="Onyx Base logo" />

# Onyx Base

### The key-value & file store that lives in Telegram.

A lightweight Supabase / Firebase–style developer platform. No database to
provision — bring a Telegram Bot Token + Chat ID (or just use the built-in
server-side storage) and you get a fast key-value database **and** a file store
(up to 50 MB upload / 20 MB download via the cloud Bot API; 2 GB both ways with
a self-hosted [Local Bot API
server](https://github.com/tdlib/telegram-bot-api)), both backed by Telegram for
durability. Ships with a real-time web dashboard, a REST API, and a
zero-dependency CLI.

**Unlimited & free.** Every operation is mirrored into a private Telegram chat,
so your full data and audit log live in Telegram — you can read your database
back from the chat itself.

<br/>

![Unlimited Free Access](https://img.shields.io/badge/Unlimited_Free_Access-d4744f?style=for-the-badge)
![No credit card](https://img.shields.io/badge/No_credit_card-e09a7a?style=for-the-badge)
![No usage caps](https://img.shields.io/badge/No_usage_caps-8a3f23?style=for-the-badge)
![No vendor lock-in](https://img.shields.io/badge/No_vendor_lock--in-2b2825?style=for-the-badge)
![Backed by Telegram](https://img.shields.io/badge/Backed_by_Telegram-d4744f?style=for-the-badge)

### Truly unlimited. Truly free.

No storage caps. No API-call quotas. No collection limits. No file-count
limits. No "contact sales" wall. No proprietary runtime. The only cost is
your own Telegram bot — talk to [@BotFather](https://t.me/BotFather), it's
free, takes 30 seconds, and you already have a Telegram account. No credit
card, no trial, no vendor lock-in: your data lives in **your** Telegram chat,
and you can walk away with it at any time.

</div>

<br/>

<!-- ───────────────────────── ARCHITECTURE OVERVIEW ───────────────────────── -->
## Architecture

Onyx Base is a Next.js application that uses Telegram as its durable storage
layer and SQLite as a fast local index. A Socket.io mini-service powers the
real-time dashboard. Clients — browser, CLI, or any HTTP library — talk to a
single REST surface.

<div align="center">

<p align="center"><img src="docs/diagrams/architecture-overview.svg" alt="Architecture overview" width="820"></p>

</div>

*Clients (browser · CLI · HTTP) → Next.js API core → { SQLite index, Telegram
durable storage, Socket.io realtime service }.*

<br/>

<!-- ───────────────────────── FEATURE GRID ───────────────────────── -->
## What's inside

Eight capabilities, one platform. Each lives behind the same API key and the
same Telegram-backed durability model.

<div align="center">

<p align="center"><img src="docs/diagrams/feature-grid.svg" alt="Feature grid" width="720"></p>

</div>

| | | |
|:---:|:---:|:---:|
| **Key-value store** — auto-typed values (string / number / boolean / JSON), grouped into collections. | **File storage** — any extension, up to 50 MB upload / 20 MB download via the cloud Bot API (2 GB with a self-hosted Local Bot API server — roadmap). Tap **Get link** to mint a signed, 1-hour download URL from Telegram (never auto-refreshed). | **Public share tokens** — scoped, rate-limited, expiring, revocable tokens for embedding in public HTML. |
| **CLI** (`onyx`) — zero-dependency Node.js tool: `set`, `get`, `list`, `export`, `upload`, `download`, `whoami`. | **REST API** — `Authorization: Bearer kv_live_…` on every `/v1/*` route. Cross-origin ready. | **Real-time dashboard** — Socket.io pushes `record:changed` events; the UI updates without polling. |

<br/>

<!-- ───────────────────────── KEYS, TOKENS & SESSIONS ───────────────────────── -->
## Keys, Tokens & Sessions

Onyx Base uses three distinct credential types — your master **API key**, scoped
**share tokens**, and short-lived signed **download tokens** — plus a
browser-side **session** store. Each one is minted, scoped, and revoked
independently. Treat them like different keys on your keyring: the API key opens
the front door, share tokens are the spare that only works on the garage, and
download tokens are an AirBnB-style temporary code that expires by itself.

### API Key — `kv_live_…`

Your master credential. The Bearer token used by the dashboard, the `onyx` CLI,
and every REST call. Grants full read/write access to everything you own.

| Property | Value |
|:---|:---|
| **Format** | `kv_live_<28 hex>` |
| **Minted** | Dashboard → **API Keys** tab (or returned once at signup). Shown exactly once at creation — copy it before closing the dialog. |
| **Scope** | Full account access: every collection, every key, every file, every share token, every log. Not scoped — it is you. |
| **Lifetime** | No expiry. Lives until you revoke it. Stored as a salted hash on the server; the plaintext is only ever shown once. |
| **Revocation** | Revoke instantly from the API Keys tab (`DELETE /api/dashboard/api-keys/:id`). The key stops authenticating on the very next request. |
| **Survives a full local-store wipe** | Yes. On a cache-miss, the auth layer fetches the pinned identity manifest from Telegram, rehydrates your user + API key records into the local store, and retries. The manifest lives in Telegram; the key matches it; you authenticate. |

```http
# Every /v1/* and /api/dashboard/* request carries this header:
Authorization: Bearer kv_live_abc123def456…

# Example: set a value
curl -X POST https://onyx.example.com/v1/set \
  -H "Authorization: Bearer kv_live_abc123def456…" \
  -H "Content-Type: application/json" \
  -d '{"key":"coins","value":500}'
```

### Share Token — `st_…`

A public, scoped, rate-limited, expiring, revocable credential that wraps
exactly one `(collection, key)` pair. Safe to embed in source-visible HTML
(CodePen, static sites, browser extensions).

| Property | Value |
|:---|:---|
| **Format** | `st_<28 hex>` |
| **Minted** | Dashboard → **Public Share** tab (`POST /api/dashboard/share-tokens`). Choose mode (`read` / `write` / `readwrite`), allowed ops, rate limit, and TTL. |
| **Scope** | One `(collection, key)` pair. A read token can only read that one key; a write token can only mutate that one key. It cannot touch anything else in your account. |
| **Lifetime** | Optional TTL (in minutes). No TTL = never expires. Rate-limited per IP, per minute (default 30). Revoke at any time. |
| **Revocation** | Revoke instantly from the Public Share tab (`DELETE /api/dashboard/share-tokens/:id`). The public URL returns 404 on the very next request. Cannot be undone — create a new token and update your HTML. |
| **Modes** | `read` (`GET /v1/share/:token`), `write` (`POST /v1/write/:token`), `readwrite` (both endpoints work). |
| **Write options** | `allowedOps` (`set` / `incr` / `append`), `maxValueLength` (bytes, default 4096), `incrMin` / `incrMax` (clamp `incr` results). |
| **URLs** | Each token comes with copy-paste-ready `readUrl` and `writeUrl`. |

```bash
# Read token (mode: read) — public, no auth header
curl https://onyx.example.com/v1/share/st_YOUR_READ_TOKEN
# → {"ok":true,"key":"visits","value":42,"type":"number"}

# Write token (mode: write, allowedOps: ["incr"]) — public, no auth
curl -X POST https://onyx.example.com/v1/write/st_YOUR_WRITE_TOKEN \
  -H "Content-Type: application/json" \
  -d '{"op":"incr","amount":1}'
# → {"ok":true,"op":"incr","value":43,"previous":42,"type":"number"}
```

### Download Token — `expiresAt.sig` (HMAC-SHA256)

A signed, 55-minute, per-file token that lets anyone holding the link download
one specific file — public or private. The signature IS the credential.

| Property | Value |
|:---|:---|
| **Format** | `<expiresAt>.<HMAC-SHA256(fileId:expiresAt, CLOUDKV_SECRET)>` (passed as `?t=…&e=…` on `/f/<fileId>`) |
| **Minted** | Auto-minted when you click **Get link** on a file row (`POST /v1/files/:id/link` or `/api/files/:id/link`). Returned alongside the Telegram cloud URL and the proxy URL. |
| **Scope** | Exactly one file (by its internal `fileId`). Cannot be used to download any other file, list files, or read KV data. |
| **Lifetime** | 55 minutes (just under Telegram's ~1-hour `getFile` URL expiry). Never auto-refreshed — the user must click **Get link** again after expiry. |
| **Revocation** | Revoke drops the cached Telegram URL on our side (`POST /v1/files/:id/revoke`). The signature itself can't be revoked, but the underlying Telegram `getFile` URL it points at expires on its own ~1-hour clock. |
| **Works for** | Both public AND private files. The signature is the credential, not the file's visibility flag. |

```bash
# Click "Get link" on a file → returns a signed URL on your origin:
#   https://onyx.example.com/f/f_a1b2c3...?t=1735900000000.7e3a9f...&e=1735900000000

# Anyone with the URL can download the file — no auth header:
curl -L -o report.pdf \
  "https://onyx.example.com/f/f_a1b2c3...?t=1735900000000.7e3a9f...&e=1735900000000"

# After 55 minutes the signature is rejected. Re-click "Get link".
```

> **Why the signature is the credential.** The token is
> `<expiresAt>.<HMAC-SHA256(fileId:expiresAt, CLOUDKV_SECRET)>`. The server
> verifies the HMAC with a constant-time comparison and checks the expiry — no
> database lookup, no session. That means the link works for both public and
> private files, works from anywhere in the world, and never exposes the
> Telegram bot token (the URL is on your origin; the server proxies the bytes
> out of Telegram behind the scenes using a cached `getFile` URL).

### Session — `cloudkv-session` (browser-side)

The dashboard stores your session in `localStorage` under the key
`cloudkv-session` — a Zustand-persisted store. It contains:

| Field | Purpose |
|:---|:---|
| `apiKey` | Your `kv_live_…` master API key. Sent as the Bearer header on every dashboard request. |
| `user` | Your profile: `userId`, `name`, `plan`, `counts` (records / collections / apiKeys / logs), and `isAdmin`. |
| `activeView` | Which dashboard tab you're on (`overview`, `database`, `collections`, `storage`, `api-keys`, `share`, `playground`, `sql`, `docs`, `logs`, `analytics`, `settings`). Persists across reloads. |
| `activeCollection` | The currently-selected collection (defaults to `default`). |
| `useAdminMode` | `true` when an admin user wants the admin console; `false` for the regular dashboard. Only meaningful when `user.isAdmin` is true. |

**This is a LOCAL session.** The server has no session table, no session
cookie, no "logged in users" list. Every request is authenticated statelessly
via the Bearer API key header. That means:

- **Clearing `localStorage` = signed out.** There is no server-side logout
  endpoint because there is no server-side session.
- **The session never leaves the browser.** Only the API key travels in the
  `Authorization` header on each request — the rest of the session state
  (`activeView`, `activeCollection`, `useAdminMode`) is purely client-side UI
  state.
- **Signing out** calls `clearSession()`, which wipes `apiKey`, `user`, and
  resets `activeView` / `activeCollection` / `useAdminMode` to defaults.
- **The API key persists in localStorage** across browser restarts. If you share
  the device, sign out when you're done. The key itself is still valid on the
  server until you revoke it from the API Keys tab.

```javascript
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
```

<br/>

<!-- ───────────────────────── FEATURE REFERENCE ───────────────────────── -->
## Feature reference

Thirteen dashboard tabs, each a real feature — not a placeholder. The icons match
the sidebar exactly.

| Tab | What it does |
|:---|:---|
| **Dashboard** | Your landing page: a welcome header, four stat cards (records / collections / files / API keys), a 7-day activity area chart, recent records list, and a quick-jump launcher. Use it as the daily entry point — it surfaces what changed since you last visited and gets you into the database or storage tab in one click. |
| **Database** | A spreadsheet-style IDE for your key-value data. Browse every record in the active collection, expand JSON cells, edit values inline, create new keys with auto-typing (string / number / boolean / JSON), and delete with a confirmation. Auto-refreshes in real time when other clients (the CLI, the API, a share-token widget) mutate a key — the row updates without a reload. |
| **Collections** | Group keys into named collections (`default`, `cache`, `metrics`, …). Create, rename, and delete whole collections in one action — deleting a collection also wipes every record inside it and mirrors the deletion to Telegram. Use collections to keep unrelated data (config vs. analytics vs. user state) cleanly separated without a second account. |
| **Cloud Storage** | A drag-and-drop file manager backed by Telegram. Upload any extension (exe, pdf, png, mp4, zip — anything) up to the effective limit (50 MB cloud Bot API, or 2 GB with a self-hosted local Bot API server). Each file gets a permanent `/f/<fileId>` proxy URL plus a signed 55-minute download token. Toggle public/private per file; track download counts. |
| **API Keys** | Mint, name, and revoke multiple `kv_live_…` API keys per account. Each key is shown exactly once at creation — copy it before closing the dialog. Use named keys to segregate access (e.g. one for production, one for staging, one for the CLI on your laptop); revoke any of them instantly without touching the others. Keys are stored as salted hashes; the plaintext is never retrievable after creation. |
| **Public Share** | Create scoped, rate-limited, expiring, revocable share tokens that wrap exactly one `(collection, key)` pair. Choose mode (`read` / `write` / `readwrite`), allowed ops (`set` / `incr` / `append`), max value length, incr bounds, per-IP rate limit, and TTL. Each token comes with copy-paste-ready `readUrl` and `writeUrl` — safe to embed in CodePen, static HTML, or browser extensions. |
| **API Playground** | An interactive REST explorer: pick an endpoint (`set` / `get` / `list` / `delete` / `files` / `share-tokens` / `whoami` / `stats` / `logs` / …), fill in the parameters, hit **Send**, and inspect the raw JSON response. Auto-injects your current API key as the Bearer header. Great for prototyping calls before committing them to code, or for debugging why a particular request returns 404. |
| **SQL Editor** | A real SQL console that runs against virtual tables (`records`, `collections`, `api_keys`, `logs`, `users`) pre-filtered to your account. Run `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `CREATE` / `DROP` / `ALTER` statements, plus create your own `usr_*` tables for custom schemas. 1000-row cap per result, API keys masked in output, `⌘+Enter` to run. The fastest way to do bulk updates or exploratory queries. |
| **Docs** | The in-app reference (the same content as the Keys/Tokens/Features/API/CLI/Realtime/Telegram sections of this README, restructured into tabs). Copy buttons on every code block, multi-language examples, and a **Copy for LLMs** button to grab the whole spec for an AI assistant. The **Single page** tab combines every section into one LLM-friendly document — the exact same content served at [`/llms.txt`](src/app/llms.txt/route.ts) (the [llmstxt.org](https://llmstxt.org) convention). |
| **Logs** | An append-only audit trail of every API event on your account: `set`, `delete`, `login`, `apikey.create`, `share.create`, file upload, `export`, and more. Each entry includes the action, the key/collection touched, the source (`dashboard` / `cli` / `api` / `share`), and a timestamp. Filter by action type, paginate through history. Every log entry is also mirrored into your Telegram chat as a structured message. |
| **Analytics** | Aggregate charts over your account activity: requests per day, top actions, top keys, share-token usage, file-download counts. Useful for spotting usage patterns (e.g. a share token that suddenly spiked traffic, or a key that's being read far more than written). All data is derived from the same logs table the Logs tab shows — just rolled up. |
| **Settings** | Account + storage configuration. View your `userId`, plan, and API-key counts. Configure your own Telegram bot (Bot Token + Chat ID) to route new KV mirrors and file uploads to your private chat instead of the shared server-side bot. Optionally set a local Bot API server URL to unlock 2 GB file uploads/downloads (vs. the cloud Bot API's 50 MB upload / 20 MB download cap). Ping the bot to verify the config. |
| **Tables** | Account-scoped SQL tables with per-table access modes (`read` / `write` / `readwrite`). Define a schema (TEXT / INTEGER / REAL / NUMERIC / BLOB / DATETIME / BOOLEAN columns, primary keys, auto-increment, defaults, nullability), then drive full CRUD from a real database-grid UI in the dashboard, the REST API (`/v1/tables/*`), or the CLI (`onyx tables`). Each table gets a unique `usr_<name>_<hash>` SQLite name so two accounts can both own a `notes` table without colliding. Toggle the access mode at any time to lock down public-facing tables — `read` blocks all writes, `write` blocks all reads, the dashboard owner always has full access. |

<br/>

<!-- ───────────────────────── REST API SURFACE ───────────────────────── -->
## REST API (`/v1/*`)

Every `/v1/*` route (and every `/api/dashboard/*` route) requires the Bearer
header — except signup, public share, public file download, and health. The same
key works for the CLI, the dashboard, and any HTTP client.

```http
Authorization: Bearer kv_live_abc123def456…
```

### Key-value

| Method | Path | Purpose |
|:---|:---|:---|
| `POST` | `/v1/set` | Set / upsert a value. Body: `{ "key", "value", "collection"? }`. Values are auto-typed (string / number / boolean / JSON). |
| `GET` | `/v1/get/:key?collection=default` | Read a value. Returns `{ ok, key, value, type, collection, updatedAt }`. 404 when the key doesn't exist. |
| `DELETE` | `/v1/delete/:key?collection=default` | Remove a key + its Telegram mirror message. 404 when the key doesn't exist. |
| `GET` | `/v1/list?collection=default` | List keys in a collection. Returns `{ ok, keys, count, collection }`. |
| `GET` | `/v1/export?collection=default` | Dump the whole database (or one collection) as a JSON object. Non-default collections are prefixed with the collection name + a dot. |

### Files

| Method | Path | Purpose |
|:---|:---|:---|
| `POST` | `/v1/files` | Upload a file (multipart: `file`, optional `label`, optional `public`). Returns file metadata + permanent `/f/<fileId>` URL. |
| `GET` | `/v1/files` | List stored files. Also returns the effective `maxFileUploadBytes` (50 MB cloud / 2 GB local). |
| `GET` | `/v1/files/:id` | File metadata. |
| `POST` | `/v1/files/:id/link` | Mint a signed 55-minute download link. Returns `{ url, proxyUrl, expiresAt, expiresInSec, revocable }`. Add `?force=1` to bypass the 55-min server cache. |
| `POST` | `/v1/files/:id/revoke` | Drop the cached Telegram `getFile` URL on our side. The next `/link` call pulls a brand-new URL. |
| `DELETE` | `/v1/files/:id` | Permanently delete a file (record + Telegram document message). |
| `GET` | `/f/:fileId?t=…&e=…` | Public download proxy — streams bytes from Telegram through your server's origin. No auth (signature is the credential). Add `?inline=1` to render in-browser. |

### Collections

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/v1/collections` | List collections (with record counts). |
| `GET` | `/v1/collections/:name` | Collection detail. |

### Tables

Account-scoped SQL tables. Each table you create gets a unique
`usr_<name>_<hash>` SQLite name so two accounts can both own a `notes` table
without colliding. Each table has an **access mode** that controls what the
public API can do: `read` → GET only; `write` → POST / PATCH / DELETE only;
`readwrite` → everything. The dashboard owner can always do everything
regardless of mode — the `/api/dashboard/tables/*` routes have the same shape
but skip the access-mode check.

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/v1/tables` | List your tables (name, accessMode, rowCount, schema, timestamps). |
| `POST` | `/v1/tables` | Create a table. Body: `{ name, columns: ColumnDef[], accessMode? }`. `ColumnDef = { name, type: TEXT\|INTEGER\|REAL\|NUMERIC\|BLOB\|DATETIME\|BOOLEAN, primary?, autoIncrement?, nullable?, defaultValue? }`. `accessMode` defaults to `readwrite`. |
| `GET` | `/v1/tables/:name` | Describe a table — schema + rowCount + sample rows + accessMode. |
| `PATCH` | `/v1/tables/:name` | Update the access mode. Body: `{ accessMode }`. Takes effect on the next request. |
| `DELETE` | `/v1/tables/:name` | Drop a table (SQLite `DROP TABLE` + metadata delete). Cannot be undone. |
| `GET` | `/v1/tables/:name/rows` | List rows (default 100, `?limit=` max 1000). Honors the access mode — 403 on a write-only table. |
| `POST` | `/v1/tables/:name/rows` | Insert a row. Body: `{ row: { col: value, … } }`. Validates against the schema; returns the inserted row with auto-incremented / defaulted columns filled in. |
| `PATCH` | `/v1/tables/:name/rows` | Update a row by primary key. Body: `{ pk: { col: value }, patch: { col: value } }`. |
| `DELETE` | `/v1/tables/:name/rows` | Delete a row by primary key. Body: `{ pk: { col: value } }`. 404 if no row matches. |

```bash
# Create a "tasks" table (read+write via the public API)
curl -X POST https://onyx.example.com/v1/tables \
  -H "Authorization: Bearer kv_live_…" \
  -H "Content-Type: application/json" \
  -d '{"name":"tasks","accessMode":"readwrite","columns":[{"name":"id","type":"INTEGER","primary":true,"autoIncrement":true},{"name":"title","type":"TEXT","nullable":false},{"name":"done","type":"BOOLEAN","defaultValue":"0"}]}'

# Insert a row
curl -X POST https://onyx.example.com/v1/tables/tasks/rows \
  -H "Authorization: Bearer kv_live_…" \
  -H "Content-Type: application/json" \
  -d '{"row":{"title":"Buy milk","done":false}}'

# List rows
curl -H "Authorization: Bearer kv_live_…" https://onyx.example.com/v1/tables/tasks/rows
```

> The dashboard mirrors the same shape under `/api/dashboard/tables/*` — list,
> create, describe, drop, mode-change, rows CRUD — but with no access-mode
> enforcement since the dashboard owner has full access. The CLI talks to the
> dashboard routes.

### Account & ops

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/v1/whoami` | Identify the current API key + user. Returns `{ userId, apiKeyId, apiKeyName, isAdmin }`. |
| `GET` | `/v1/health` | Service + Telegram storage status. Liveness + readiness probe. No auth. |
| `GET` | `/v1/stats` | Account statistics (records / collections / apiKeys / logs / files counts, activity by day, recent activity). |
| `GET` | `/v1/logs?limit=50&action=…` | Recent audit log entries, optionally filtered by action. |

### Share tokens (public surface)

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/v1/share/:token` | **Public** scoped read — no auth. Returns the value, type, and updatedAt for the single key the token wraps. |
| `POST` | `/v1/write/:token` | **Public** scoped write — no auth. Body: `{ "op": "set"|"incr"|"append", "value"?, "amount"? }`. Honors `allowedOps`, `maxValueLength`, `incrMin/incrMax`, and the per-IP rate limit. |
| `POST` | `/api/dashboard/share-tokens` | Create a share token (auth required). Body: `{ collection?, key, mode, label?, ttlMinutes?, rateLimitPerMin?, allowedOps?, maxValueLength?, incrMin?, incrMax? }`. |
| `GET` | `/api/dashboard/share-tokens` | List your share tokens (auth required). |
| `DELETE` | `/api/dashboard/share-tokens/:id` | Revoke a share token instantly (auth required). The public URL returns 404 on the next request. |

### Advanced (`/api/v1/*`)

A Supabase-style advanced surface lives under `/api/v1/*` (note the `/api`
prefix, distinct from the basic `/v1/*` surface). All routes require the Bearer
API key and are scoped to the authenticated user.

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/views` | List named views (projections over a collection). Create with `POST /api/v1/views { name, collection, projection, filter? }`. |
| `GET` | `/api/v1/views/:name` | Execute a stored view — applies its substring filter on the key and projects the requested columns. |
| `GET` | `/api/v1/matviews` | List materialized views (pre-computed aggregations cached as JSON). Create with `POST /api/v1/matviews { name, query }`. Refresh-all with `POST /api/v1/matviews { action: "refresh_all" }`. |
| `GET` | `/api/v1/matviews/:name` | O(1) read of the cached aggregation result. `POST` to refresh, `DELETE` to drop. |
| `POST` | `/api/v1/functions` | Create a server-side function. Body: `{ name, code }`. Runs in a `new Function("ctx", code)` sandbox with `{ record, db, user }` — `db` is read-only and user-scoped. 5s timeout, syntax-checked at create. |
| `POST` | `/api/v1/functions/:name` | Test-invoke a stored function with the supplied `ctx` body. |
| `POST` | `/api/v1/rpc/:name` | Built-in RPC: `count_records`, `sum { key }`, `aggregate { collection, type }`, `search { query, collection?, limit? }`, `touch { key, value, collection? }`. All user-scoped. |
| `POST` | `/api/v1/graphql` | Minimal hand-rolled GraphQL endpoint (no Apollo/graphql deps). Queries for `records`, `collections`, `apiKeys`, `logs`, `me` — all user-scoped. Args + variables supported on `records(limit, collection)` and `logs(limit, action)`. Standard `{ data, errors }` response. |

> The full surface — including dashboard routes (`/api/dashboard/*`) and admin
> routes (`/api/admin/*`) — is in the **API surface** section below.

<br/>

<!-- ───────────────────────── WRITE PATH DATA FLOW ───────────────────────── -->
## How a write flows

Every mutation is fast (SQLite index) **and** durable (Telegram mirror). The
identity manifest is re-pinned so the platform can self-heal after a full reset.

<div align="center">

<p align="center"><img src="docs/diagrams/write-data-flow.svg" alt="Write data flow" width="820"></p>

</div>

*`set key` → SQLite upsert (fast read path) → Telegram mirror message (durable
backup) → identity manifest re-pinned (self-healing after reset).*

<br/>

<!-- ───────────────────────── STORAGE ROUTING ───────────────────────── -->
## File storage routing

Uploads **automatically** use the server-side Telegram bot when no custom config
is set up. Set up your own bot in Settings to route new uploads to your private
chat. Each file remembers which backend holds it, so downloads and deletes always
hit the correct bot — even if you change config later.

### On-demand download links (Telegram's 1-hour rule)

Telegram revokes every `getFile` download URL after **~1 hour**. Onyx Base
respects that limit instead of fighting it:

- Every file row has a **Get link** button. Tap it → the backend asks Telegram's
  `getFile` API for a fresh **Telegram cloud URL** (`https://api.telegram.org/file/bot…/…`)
  and returns it directly. Telegram revokes this URL after ~1 hour — that's
  Telegram's built-in behaviour, not ours.
- A live countdown shows when the link expires. After expiry, tap **Refresh**
  to pull a brand-new URL from Telegram.
- **Revoke** drops the cached URL from our server immediately and marks the
  file's link as revoked. The next **Get link** call mints a brand-new URL via
  a fresh `getFile` call. (Note: Telegram's own URL remains valid until its
  natural ~1-hour expiry — we can't force Telegram to revoke it sooner — but
  we no longer cache or re-serve it on our side.)
- Links are fetched **only on your tap**, never automatically — so the Telegram
  API is never spammed. A 55-minute server-side cache means even repeated
  calls for the same file make at most one `getFile` call per hour.
- A **proxy URL** on your server's origin (`/f/<fileId>`) is also returned as a
  fallback — permanent for public files, works worldwide, and never exposes
  the Telegram bot token.

<div align="center">

<p align="center"><img src="docs/diagrams/storage-routing.svg" alt="Storage routing" width="780"></p>

</div>

*Upload → **full custom config?** → yes: your own Telegram bot · no: the
server-side bot (automatic). Both produce a permanent `/f/<id>` link.*

<br/>

<!-- ───────────────────────── SHARE TOKEN SECURITY ───────────────────────── -->
## Public share tokens — layered security

A share token wraps a single key in five concentric layers of protection, so it
is safe to embed in source-visible platforms (static HTML, CodePen, etc.).

<div align="center">

<p align="center"><img src="docs/diagrams/share-token-security-layers.svg" alt="Share token security layers" width="560"></p>

</div>

From the inside out: the **key** → **scope** (one key only) → **mode**
(read / write / readwrite) → **rate limit** (requests per minute) → **TTL**
(auto-expiry) → **revocable** (instant kill switch).

<br/>

<!-- ───────────────────────── AUTH & RECOVERY ───────────────────────── -->
## Authentication & recovery

Your API key (`kv_live_…`) is the only credential needed for all data
operations. A separate email + password exists solely for key recovery. Every
identity mutation is mirrored to the Telegram pinned manifest, so the platform
can self-heal after a full reset.

<div align="center">

<p align="center"><img src="docs/diagrams/authentication-and-recovery-flow.svg" alt="Authentication and recovery flow" width="820"></p>

</div>

*Sign in via API key **or** email + password → dashboard. Lose your key? Recover
it from the Telegram pinned manifest. Disposable-email signups are blocked at
the door.*

<br/>

<!-- ───────────────────────── ADMIN SYSTEM ───────────────────────── -->
## Admin system

Onyx Base ships with a built-in admin role that can see and manage **every
user's data** on the instance — useful for self-hosted operators, support
workflows, and disaster recovery. Admins use a separate key prefix
(`onyxbase_…`) that unlocks a dedicated admin console alongside the regular
dashboard.

### The bootstrap admin key

Every instance boots with one irrevocable admin key that **you set yourself**
in `.env`:

```bash
# .env (NEVER commit this file — it's gitignored)
BOOTSTRAP_ADMIN_KEY=onyxbase_<your-own-long-random-string>
```

Generate one with, for example, `openssl rand -hex 16` and prefix it with
`onyxbase_`. Sign in with this key (web UI or CLI) to enter the **Admin
Dashboard** — a separate console that shows every user, their collections,
keyvalues, files, and API keys. The bootstrap key cannot be revoked or rotated
from the UI; rotate it by changing the env var and redeploying.

### Accessing the admin dashboard

Two ways in:

1. **Sign in** with the admin key on the regular login screen — Onyx Base
   detects the `onyxbase_` prefix and routes you straight into the admin
   console. A header toggle lets you switch between the admin console and the
   regular user dashboard at any time.
2. **Direct URL** — visit [`/admin`](src/app/admin/page.tsx) on your instance.
   If you aren't signed in yet, you'll be asked for an admin key; if you are,
   the admin console loads immediately.

### What the admin can see

- **Users** — every account with stats (records, files, collections, last
  activity, signup time).
- Per-user detail: **collections**, **keyvalues** (full database-IDE table
  with sortable columns and expandable JSON), **files** (with Telegram
  direct-link mint / refresh / revoke), and **API keys**.
- **All files** — across every user, with the same Get-link / Refresh / Revoke
  controls as the regular storage tab.
- **Admin keys** — list and revoke promoted admin keys (the bootstrap key
  cannot be revoked).

### Promoting a user to admin

To grant admin powers to a regular user (e.g. a teammate who needs
cross-user visibility), promote their existing `kv_live_` API key to an
`onyxbase_` key:

```bash
# CLI:
onyx admin promote kv_live_abc123def456 --label "Ada (ops)"

# Or via curl:
curl -X POST https://onyx.example.com/api/admin/promote \
  -H "Authorization: Bearer $BOOTSTRAP_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kvLiveKey":"kv_live_abc123def456","label":"Ada (ops)"}'
# → { "adminKey": "onyxbase_a1b2c3d4e5f6…", "label": "Ada (ops)" }
```

The promoted user gets back a fresh `onyxbase_<hex>` key — they sign in with
that from then on. Their original `kv_live_` key still works for ordinary
user-level data operations.

### Revoking an admin key

```bash
onyx admin revoke onyxbase_a1b2c3d4e5f6
# or via curl:
curl -X DELETE "https://onyx.example.com/api/admin/admins?id=<adminKeyId>" \
  -H "Authorization: Bearer $BOOTSTRAP_ADMIN_KEY"
```

The bootstrap key (the value you set in `BOOTSTRAP_ADMIN_KEY`) is
**irrevocable** — attempting to delete it returns a 409 Conflict. To rotate
it, change the env var and redeploy.

<br/>

<!-- ───────────────────────── TECH STACK LAYERS ───────────────────────── -->
## Tech stack

Four layered concerns, one cohesive warm palette. The outermost layer (Telegram)
is the durable substrate; the innermost (UI) is what you click.

<div align="center">

<p align="center"><img src="docs/diagrams/tech-stack-layers.svg" alt="Tech stack layers" width="780"></p>

</div>

*Telegram (durable storage) → Next.js API routes (logic) → Prisma + SQLite (fast
index) → React + shadcn/ui (dashboard).*

<br/>

<!-- ───────────────────────── QUICK START ───────────────────────── -->
## Quick start

Onyx Base is a cloud-hosted service — once deployed, every developer gets a
public URL. Replace `https://onyx.example.com` below with your instance's URL
(or just use the hosted dashboard in your browser).

```bash
# 1. Install & run the web app (self-host)
bun install
bun run db:push     # create the SQLite schema
bun run dev         # starts on http://localhost:3000 locally

# 2. Create an account (web UI, CLI, or curl) — use your deployed URL in production
curl -X POST https://onyx.example.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","password":"secret123"}'
# → { "apiKey": "kv_live_…" }

# 3. Store and read your first value
curl -X POST https://onyx.example.com/v1/kv/default/visits \
  -H "Authorization: Bearer kv_live_…" \
  -H "Content-Type: application/json" \
  -d '{"value": 0}'

curl https://onyx.example.com/v1/kv/default/visits \
  -H "Authorization: Bearer kv_live_…"
# → { "value": 0, "type": "number" }

# 4. Upload a file (any extension, up to 50 MB via cloud Bot API) — auto-routed to server-side Telegram
curl -X POST https://onyx.example.com/v1/files \
  -H "Authorization: Bearer kv_live_…" \
  -F "file=@./report.pdf"
# → { "file": { "id": "…", "fileId": "f_…", "storageMode": "server", "isPublic": true } }

# 5. Mint a fresh Telegram cloud download link (revoked by Telegram after ~1h)
curl -X POST https://onyx.example.com/api/files/<id>/link \
  -H "Authorization: Bearer kv_live_…"
# → { "url": "https://api.telegram.org/file/bot…/…",   ← raw Telegram cloud URL
#     "proxyUrl": "https://onyx.example.com/f/f_…",     ← permanent proxy fallback
#     "expiresAt": 1735900000000, "expiresInSec": 3300, "revocable": true }

# 6. Download the file — the Telegram URL works from anywhere for ~1 hour
curl -L "https://api.telegram.org/file/bot…/…" -o report.pdf

# Revoke the cached link (drops our cache; the next /link call mints a new URL):
curl -X POST https://onyx.example.com/api/files/<id>/revoke \
  -H "Authorization: Bearer kv_live_…"

# After the link expires, mint a new one (add ?force=1 to bypass the cache):
curl -X POST "https://onyx.example.com/api/files/<id>/link?force=1" \
  -H "Authorization: Bearer kv_live_…"
```

> Download links are **Telegram's raw cloud URLs** (`api.telegram.org/file/…`),
> valid for ~1 hour (Telegram's built-in revocation). The server caches each
> URL for 55 minutes so repeated calls make at most one `getFile` call per hour —
> Telegram is never spammed. Mint a new link after expiry. **Revoke** drops our
> cache immediately; the next Get link call pulls a brand-new URL from Telegram.
> A permanent proxy URL (`/f/<fileId>`) is also returned for public files.

### CLI

```bash
npm i -g onyx-base
export ONYX_URL=https://onyx.example.com

# Auth & data
onyx login --name "Ada" --email ada@example.com
onyx set visits 0
onyx get visits
onyx list                          # list keys in the default collection
onyx export --output backup.json   # dump the whole database as JSON

# Collections
onyx collections                   # list collections (+ record counts)
onyx collections --create cache    # create a new collection

# Files
onyx upload ./report.pdf --label "Q3 report"
onyx files                         # list stored files
onyx download f_abc123 ./out.pdf
onyx file-link f_abc123            # mint a fresh Telegram cloud URL (~1h)
onyx file-revoke f_abc123          # drop the cached URL immediately
onyx file-delete f_abc123          # permanently delete a file

# Tables (account-scoped SQL tables)
onyx tables                                  # list your tables (alias: tbl)
onyx tables create tasks --columns "id:INTEGER:pk:ai,title:TEXT:notnull,body:TEXT" --access rw
onyx tables describe tasks                   # schema + sample rows
onyx tables rows tasks                       # list rows (default 100)
onyx tables insert tasks --data '{"title":"Buy milk","done":false}'
onyx tables update tasks --pk '{"id":1}' --data '{"done":true}'
onyx tables delete tasks --pk '{"id":1}' --yes
onyx tables drop tasks --yes                 # drop the whole table
onyx tables mode tasks r                     # change access mode (r=read, w=write, rw=readwrite)
```

**Column-spec mini-DSL.** The `--columns` argument to `onyx tables create`
takes a comma-separated list of column specs, each in the form:

```
name:TYPE[:pk][:ai][:notnull][:default=VALUE]
```

`name` is any SQL-safe identifier; `TYPE` is one of `INTEGER`, `TEXT`, `REAL`,
`NUMERIC`, `BLOB`, `DATETIME`, `BOOLEAN`; `pk` marks the column as `PRIMARY KEY`;
`ai` adds `AUTOINCREMENT` (implies `INTEGER` + `pk`); `notnull` adds `NOT NULL`;
`default=VALUE` sets a `DEFAULT`. Colons inside a quoted `default=…` value are
respected, e.g. `"ts:DATETIME:default=2024-01-01 12:00:00"` is one column, not
four. The CLI parses this spec client-side and POSTs the same
`{ name, columns: ColumnDef[], accessMode }` body the REST API expects.

```bash
# Share tokens
onyx share --key visits --mode read --ttl 3600   # mint a scoped share token
onyx share --list                               # list your share tokens
onyx share --revoke <tokenId>                    # revoke one

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
```

<br/>

<!-- ───────────────────────── API SURFACE ───────────────────────── -->
## API surface

Every route below (except `signup` / `share` / `recover` / `f/[id]`) requires:

```
Authorization: Bearer kv_live_…
```

| Method | Path | Purpose |
|:---|:---|:---|
| `POST` | `/api/auth/register` | Create account → returns API key |
| `POST` | `/api/auth/login` | Email + password recovery login |
| `POST` | `/api/auth/recover` | Restore keys from a Telegram manifest paste |
| `GET` | `/v1/kv/:collection/:key` | Read a value |
| `POST` | `/v1/kv/:collection/:key` | Set / upsert a value (auto-typed) |
| `DELETE` | `/v1/kv/:collection/:key` | Delete a value |
| `GET` | `/v1/kv/:collection` | List keys in a collection |
| `GET` | `/v1/export` | Dump the whole database as JSON |
| `POST` | `/v1/files` | Upload a file (multipart) → file metadata |
| `GET` | `/v1/files` | List stored files |
| `GET` | `/v1/files/:id` | File metadata |
| `DELETE` | `/v1/files/:id` | Permanently delete a file |
| `POST` | `/api/files/:id/link` | Mint a Telegram cloud URL (cached ~55 min; `?force=1` to bypass) |
| `POST` | `/api/files/:id/revoke` | Drop the cached Telegram URL + mark the link revoked |
| `POST` | `/v1/files/:id/link` | REST equivalent — mint a Telegram cloud URL |
| `POST` | `/v1/files/:id/revoke` | REST equivalent — revoke the cached link |
| `GET` | `/f/:fileId` | Public download proxy (no auth) — streams bytes from Telegram |
| `GET` | `/v1/whoami` | Identify the current API key + user |
| `GET` | `/v1/stats` | Account statistics (records, files, activity, …) |
| `GET` | `/v1/logs` | Recent audit log entries (`?limit=50&action=…`) |
| `GET` | `/v1/health` | Service + Telegram storage status |
| `GET` | `/llms.txt` | **LLM-friendly single-page spec** — combines every Docs tab into one markdown document (the [llmstxt.org](https://llmstxt.org) convention). No auth. Cached for 1 hour. The dashboard's "Copy for LLMs" button fetches this same text. |
| `GET` | `/v1/collections` | List collections (with record counts) |
| `POST` | `/v1/collections` | Create a collection (body: `{"name":"cache"}`) |
| `DELETE` | `/v1/collections/:name` | Delete a collection + all its records |
| `GET` | `/v1/tables` | List your tables (account-scoped SQL tables) |
| `POST` | `/v1/tables` | Create a table — body: `{ name, columns: ColumnDef[], accessMode? }` |
| `GET` | `/v1/tables/:name` | Describe a table (schema + rowCount + sample rows + accessMode) |
| `PATCH` | `/v1/tables/:name` | Update the access mode (`read` / `write` / `readwrite`) |
| `DELETE` | `/v1/tables/:name` | Drop a table (SQLite `DROP TABLE` + metadata delete) |
| `GET` | `/v1/tables/:name/rows` | List rows (default 100, `?limit=` max 1000; honors access mode) |
| `POST` | `/v1/tables/:name/rows` | Insert a row — body: `{ row: { col: value, … } }` |
| `PATCH` | `/v1/tables/:name/rows` | Update a row by PK — body: `{ pk: { col: value }, patch: { col: value } }` |
| `DELETE` | `/v1/tables/:name/rows` | Delete a row by PK — body: `{ pk: { col: value } }` |
| `GET` | `/api/dashboard/tables` | List your tables (dashboard — no access-mode enforcement) |
| `POST` | `/api/dashboard/tables` | Create a table (dashboard) |
| `GET` | `/api/dashboard/tables/:name` | Describe a table (dashboard) |
| `PATCH` | `/api/dashboard/tables/:name` | Update access mode (dashboard) |
| `DELETE` | `/api/dashboard/tables/:name` | Drop a table (dashboard) |
| `GET` | `/api/dashboard/tables/:name/rows` | List rows (dashboard) |
| `POST` | `/api/dashboard/tables/:name/rows` | Insert a row (dashboard) |
| `PATCH` | `/api/dashboard/tables/:name/rows` | Update a row by PK (dashboard) |
| `DELETE` | `/api/dashboard/tables/:name/rows` | Delete a row by PK (dashboard) |
| `GET` | `/v1/share/:token` | **Public** scoped read (no auth) |
| `POST` | `/v1/write/:token` | **Public** scoped write (incr / set / append) |
| `POST` | `/api/dashboard/share-tokens` | Create a scoped share token |
| `GET` | `/api/dashboard/share-tokens` | List your share tokens |
| `DELETE` | `/api/dashboard/share-tokens/:id` | Revoke a share token |
| `GET` | `/api/dashboard/collections` | List collections (dashboard) |
| `POST` | `/api/dashboard/collections` | Create a collection (dashboard) |
| `DELETE` | `/api/dashboard/collections/:name` | Delete a collection (dashboard) |

**Admin routes** — require `Authorization: Bearer onyxbase_…`:

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/admin/whoami` | Confirm admin identity + bootstrap flag |
| `GET` | `/api/admin/users` | List ALL users with stats + global stats |
| `GET` | `/api/admin/users/:id` | Per-user detail: collections, records, files, API keys |
| `GET` | `/api/admin/files` | List ALL files across ALL users with owner info |
| `POST` | `/api/admin/files/:id/link` | Admin override — mint Telegram URL for ANY user's file (`?force=1` bypasses cache) |
| `DELETE` | `/api/admin/files/:id/link` | Admin override — revoke cached URL for ANY user's file |
| `POST` | `/api/admin/promote` | Promote a `kv_live_` key to an `onyxbase_` key (body: `{kvLiveKey, label}`) |
| `GET` | `/api/admin/admins` | List all admin keys (bootstrap flagged) |
| `DELETE` | `/api/admin/admins?id=` | Revoke an admin key (bootstrap cannot be revoked → 409) |

**Advanced surface** — `/api/v1/*` (Supabase-style) and DB branching. Same Bearer
auth, scoped to the calling user (admin key sees the admin's own data, not
cross-user):

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/views` | List named views (SQL VIEW equivalent). Create with `POST /api/v1/views { name, collection, projection, filter? }`. |
| `GET` | `/api/v1/views/:name` | Execute a stored view — applies the substring filter, projects the requested columns. |
| `GET` | `/api/v1/matviews` | List materialized views (cached aggregations). Create with `POST /api/v1/matviews { name, query }`. Refresh-all with `POST /api/v1/matviews { action: "refresh_all" }`. |
| `GET/POST/DELETE` | `/api/v1/matviews/:name` | O(1) read of the cached result (`GET`); refresh (`POST`); drop (`DELETE`). |
| `POST` | `/api/v1/functions` | Create a server-side function. Body: `{ name, code }`. Runs in a `new Function("ctx", code)` sandbox with `{ record, db, user }` — `db` is read-only and user-scoped. 5s timeout, syntax-checked at create. |
| `POST` | `/api/v1/functions/:name` | Test-invoke a stored function with the supplied `ctx` body. |
| `POST` | `/api/v1/rpc/:name` | Built-in RPC: `count_records`, `sum { key }`, `aggregate { collection, type }`, `search { query, collection?, limit? }`, `touch { key, value, collection? }`. All user-scoped. |
| `POST` | `/api/v1/graphql` | Minimal hand-rolled GraphQL (no Apollo/graphql deps). Queries for `records`, `collections`, `apiKeys`, `logs`, `me` — all user-scoped. Args + variables on `records(limit, collection)` and `logs(limit, action)`. Standard `{ data, errors }` response. |
| `GET/POST` | `/api/admin/branches` | List / create DB branches (snapshot SQLite + JSON cache under a named branch). |
| `DELETE` | `/api/admin/branches/:name` | Drop a branch (delete the snapshot, keep the live DB). |

<br/>

<!-- ───────────────────────── DESIGN SYSTEM ───────────────────────── -->
## Design system

The dashboard uses a Claude-inspired warm palette — paper-like cream surfaces,
clay accents, and warm ink text. Light theme by default; a dark variant is
available via `.dark`.

<div align="center">

<p align="center"><img src="docs/diagrams/color-palette.svg" alt="Color palette" width="720"></p>

</div>

| Token | Hex | Role |
|:---|:---|:---|
| `--primary` | `#d4744f` | Clay — brand accent, primary buttons, active state |
| `--chart-2` | `#e09a7a` | Light clay — secondary accents, gradients |
| `--accent` | `#f7e8df` | Clay tint — subtle fills, info banners |
| `--background` | `#f4f3ee` | Cream — page background |
| `--card` | `#ffffff` | White — cards, popovers |
| `--foreground` | `#2b2825` | Warm ink — headings, body |
| `--muted-stone` | `#b1ada1` | Muted stone — borders, dividers |
| `--muted-foreground` | `#6b6557` | Muted text — secondary copy |
| `--border` | `#d9d4c7` | Hairline borders |
| `--destructive` | `#c0392b` | Destructive actions |

<br/>

<!-- ───────────────────────── PROJECT LAYOUT ───────────────────────── -->
## Project layout

```
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
└── index.js            # the zero-dependency `onyx` CLI
prisma/
└── schema.prisma       # User, ApiKey, Collection, Record, Log…
```

<br/>

<!-- ───────────────────────── TELEGRAM SETUP ───────────────────────── -->
## Bring Your Own Bot (recommended for production)

Onyx Base works out of the box with a server-side shared bot — but for anything
beyond tinkering, **bring your own bot**. It costs nothing, takes 30 seconds,
and gives you dramatically more control:

- **Full control.** You own the bot token. Revoke, rotate, or replace it
  anytime without coordination.
- **Private storage.** Every KV mirror message, every uploaded file, and the
  pinned identity manifest land in **your** Telegram chat — not a shared pool
  that other tenants can read.
- **No shared bandwidth.** The default server bot's `getFile` quota is shared
  across every user on the instance. Your own bot has its own dedicated quota.
- **No shared rate limits.** Telegram throttles per-bot, so the busier the
  shared bot gets, the slower everyone's downloads become. With your own bot,
  you're the only tenant.
- **Your data stays with you.** Stop using Onyx Base tomorrow and your full
  database is still sitting in your Telegram chat, fully readable.
- **Up to 2 GB per file (with a local Bot API server).** Telegram's cloud Bot
  API caps at ~50 MB upload / ~20 MB `getFile`. Running your own [local Bot API
  server](https://github.com/tdlib/telegram-bot-api) unlocks the full 2 GB
  envelope app-side. Out of the box (no local server), the practical per-file
  limits are **50 MB upload** and **20 MB download**.

### How to set it up

1. Create a bot via [@BotFather](https://t.me/BotFather) → copy the **Bot Token**.
2. Create a channel or group, add the bot as an **administrator**.
3. Forward any message from that chat to [@userinfobot](https://t.me/userinfobot) to get the **Chat ID** (it looks like `-1001234567890`).
4. In the dashboard → **Settings → Storage backend**, paste the Chat ID and Bot Token, and save.

   Or from the CLI:

   ```bash
   onyx telegram-config --token "<bot_token>" --chat "<chat_id>"
   ```

From that point, new uploads and KV mirrors go to **your** bot. Existing files
stay on whichever backend they were uploaded to (each file remembers its
backend), so downloads and deletes keep working seamlessly.

> **Default limits (no setup):** the cloud Telegram Bot API caps bot uploads
> at ~50 MB and `getFile` downloads at ~20 MB. The full 2 GB envelope (both
> directions) is unlocked by running a [local Bot API
> server](https://github.com/tdlib/telegram-bot-api); the 2 GB ceiling is
> enforced app-side either way. Onyx Base does not currently wire up a local
> Bot API server for you — it is a roadmap item (operator-configurable
> `TELEGRAM_BOT_API_URL`).

> The server's default bot is **shared** and intended for evaluation / demos
> only. For production, **bring your own bot.**

<br/>

<!-- ───────────────────────── ROADMAP ───────────────────────── -->
## Roadmap — 25 more Telegram-powered features

The features below are **ideas only** — none of them are implemented yet. Each
one leans on a unique property of the Telegram Bot API (chat-as-storage,
message-edit, pinned messages, file attachments, channels, topic threads,
replies, inline keyboards, callback queries, `forwardMessage`,
`copyMessage`, `editMessageText`, `setMyCommands`, Telegram Passport, message
scheduling, polls, stickers, etc.). They are grouped into five categories of
five. Vote for your favourites by opening an issue, or build one yourself on
top of the existing `/v1/*` surface and `/v1/tables/*` endpoints.

### Storage models

1. **Channel-as-collection** — each Telegram channel maps 1-to-1 to a KV
   collection; posting a message in the channel creates a record, deleting the
   message drops the key. Channels become first-class, externally-addressable
   namespaces.
2. **Topic-thread collections** — in a supergroup with topics enabled, each
   topic thread is a sub-collection. One chat can host dozens of parallel
   collections, partitioned by `topic_id`, with per-topic ACLs inherited from
   the group.
3. **Message-thread transactions** — group a multi-key transaction as a reply
   thread: each reply is one mutated key, and the thread closes atomically when
   the parent message is edited to `committed`. Rollback = deleting the thread.
4. **Pinned-message indexes** — maintain B-tree-like secondary indexes as
   pinned messages — one pinned JSON document per indexed column, re-pinned on
   every write. Lookups become O(1) chat reads instead of full scans.
5. **File-dedup via `file_unique_id`** — Telegram assigns every uploaded file
   a globally-unique `file_unique_id`. Detect duplicate uploads by it and
   dedupe — store one Telegram document, reference-count the rest.

### Bot interactions

6. **Telegram-native CRUD bot** — reply to a KV mirror message in the chat to
   update the corresponding record; the bot parses the reply and mutates the
   store. Edit a mirror message to overwrite, delete it to drop the key.
7. **Bot-command SQL REPL** — `setMyCommands` registers `/sql`, `/get`,
   `/set`, `/list`. Run `/sql SELECT * FROM tasks WHERE done=0` directly in
   the chat; the bot returns the result as a formatted message or CSV
   attachment.
8. **Inline-keyboard TTL controls** — every mirror message ships with inline
   buttons: `+1h`, `+1d`, `revoke`. Tapping a button fires a `callback_query`
   that adjusts the record's TTL without an API call.
9. **Sticker-as-boolean toggle** — react to a mirror message with a 👍 sticker
   to flip a boolean key true, 👎 to flip it false. The bot watches
   `message_reactions` and mutates the store in response.
10. **Webhook-from-reply** — reply `retry` to a failed-write mirror message to
    replay the operation. Reply `rollback` to undo. The reply chain becomes a
    per-record operations console.

### Replication & backup

11. **Cross-chat replication** — mirror the same record to N Telegram chats
    for multi-region redundancy. Reads fail over to the next chat on a 404;
    writes fan out and reconcile via the pinned manifest.
12. **Bot-2-bot hot backup** — a second bot mirrors the first bot's chat via
    `getUpdates` + `forwardMessage`, giving a hot-standby that can take over
    instantly if the primary bot token is compromised or revoked.
13. **Message-edit diff log** — every KV edit's Telegram mirror keeps the
    previous value as a reply in the thread — free, append-only version
    history with no extra storage cost.
14. **Channel-topic partitions** — shard a hot collection across multiple
    topics in a channel for write throughput. The bot hashes the key →
    `topic_id`, so writes spread across topics instead of contending on one.
15. **Forwarded-message provenance** — when a record is copied from another
    chat, store the original `chat_id` + `message_id` as provenance metadata —
    giving every value an audit trail back to its source.

### Developer experience

16. **Telegram-login-widget sessions** — replace the email+password recovery
    flow with Telegram's login widget — sign in with one tap, no OTP, no
    password to forget. The bot's signed identity proof becomes the session.
17. **Chat-as-a-queue** — use a dedicated chat as a FIFO work queue: producers
    send messages, consumers poll via `getUpdates` with a long-poll offset.
    `ack` = `deleteMessage`, `retry` = `editMessage` + repost.
18. **Scheduled writes via message scheduling** — Telegram's
    `schedule_message` becomes a delayed KV write: schedule a message 24h
    out, and the bot applies it as a `set` when it fires. Cron, but stored in
    Telegram.
19. **QR-code value replies** — after every `set`, the bot replies with a QR
    code image of the value — scan-to-share on mobile without copy-paste.
    Optional per-collection toggle.
20. **Voice-note transcriptions** — upload a voice message; the bot
    transcribes it via Whisper and stores the text as the value. Audio +
    transcript both live in Telegram, retrievable as a paired album.

### Integrations

21. **Telegram-passport-backed auth** — use Telegram Passport for KYC-verified
    accounts — the bot requests identity documents, the user approves via
    Telegram's native UI, and the verified status is mirrored to the manifest.
22. **Poll-backed aggregations** — a Telegram poll mirrors a numeric KV
    counter; votes update it via `getUpdates`. Closing the poll freezes the
    counter, exporting the result as a snapshot matview.
23. **Album-as-document** — group multiple file uploads as a single logical
    document via Telegram's media-album feature. One record, N attachments,
    atomic download.
24. **Message-reply-graph for FKs** — model foreign-key relationships as reply
    chains — a child record's mirror message replies to its parent's.
    Cascading deletes = walk the reply tree with `deleteMessage`.
25. **Animated-avatar config reflection** — store user profile config (theme,
    avatar, status text) as KV; the bot's own avatar and bio reflect the live
    state, so the bot's profile is a live status board.

> None of these are implemented yet — they are design notes to show how much
> further Telegram-as-a-database can go.

<br/>

<!-- ───────────────────────── LICENSE ───────────────────────── -->
## License

MIT — build on it, ship it, make it yours.

<div align="center">

<sub>Built with Next.js 16 · Prisma · Socket.io · Telegram · shadcn/ui</sub>
<br/>
<sub>Palette: Claude-inspired warm clay on cream.</sub>

</div>
