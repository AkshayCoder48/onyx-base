import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Served at /llms.txt — the llmstxt.org convention: a markdown overview of the
// project, optimised for AI agents. Mirrors the in-app Docs tab; the dashboard's
// "Copy for LLMs" button fetches this same text and writes it to the clipboard.
const LLMS_TXT = `# Onyx Base

> The key-value & file store that lives in Telegram. A lightweight Supabase/Firebase-style developer platform — no database to provision, free and unlimited, your data lives in your own Telegram chat.

Next.js 16 BaaS: Telegram is durable storage, SQLite (via Prisma) is the fast local index. Bring a Bot Token + Chat ID (or use the built-in server-side bot) → get a key-value database AND a file store, plus a real-time dashboard, REST API, and a zero-dependency CLI.

## Quick start

\`\`\`bash
# 1. Create an account (returns your API key)
curl -X POST $ORIGIN/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Ada","email":"ada@example.com","source":"cli"}'
# → {"ok":true,"userId":"usr_xxx","apiKey":"kv_live_xxx"}

# 2. Set + 3. read back
curl -X POST $ORIGIN/v1/set -H "Authorization: Bearer kv_live_xxx" \\
  -H "Content-Type: application/json" -d '{"key":"greeting","value":"hello world"}'
curl $ORIGIN/v1/get/greeting -H "Authorization: Bearer kv_live_xxx"
\`\`\`

Replace \`$ORIGIN\` with your deployment URL.

## REST API

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/register | none | Create account → \`kv_live_*\` key |
| POST | /api/auth/login | none | Sign in (email + password) |
| POST | /api/auth/recover | none | Recover a lost key via email + password |
| GET  | /api/auth/whoami | Bearer | Verify key, show user |
| POST | /v1/set | Bearer \`kv_live_*\` | Upsert key/value (auto-typed) |
| GET  | /v1/get/:key?collection= | Bearer | Read one value (404 if missing) |
| DELETE | /v1/delete/:key?collection= | Bearer | Remove key + Telegram mirror |
| GET  | /v1/list?collection= | Bearer | List keys |
| GET  | /v1/export?collection= | Bearer | Dump \`{key: value}\` as JSON |
| POST | /v1/files | Bearer | Upload file (multipart) → \`/f/<fileId>\` |
| GET  | /v1/files | Bearer | List files |
| GET  | /f/:fileId | none* | Download proxy (*signed token for private files) |
| GET  | /v1/share/:token | none | Public read of one scoped key |
| POST | /v1/write/:token | none | Public write (\`incr\`/\`set\`/\`append\`) to one scoped key |
| GET  | /v1/whoami · /v1/health · /v1/stats · /v1/logs | Bearer | Telemetry |
| GET  | /api/admin/users · /api/admin/files | Bearer \`onyxbase_*\` | Admin |
| POST | /api/admin/promote | Bearer \`onyxbase_*\` | Promote \`kv_live_*\` → \`onyxbase_*\` |

## Auth model

- **\`kv_live_*\`** — per-user API keys (\`Authorization: Bearer kv_live_…\`). Full read/write to that user's data only. Revocable, named, multiple per account.
- **\`onyxbase_*\`** — admin API keys. Same Bearer scheme. Grants \`/api/admin/*\` access. Seeded via \`BOOTSTRAP_ADMIN_KEY\` env; more promoted from existing \`kv_live_*\` keys.
- **Share tokens (\`st_*\`)** — scoped, revocable, rate-limited public credentials for client-side code. Bound to one \`(collection, key)\`; mode-restricted (read XOR write); op-restricted (\`set\`/\`incr\`/\`append\`); TTL-expiring; per-IP rate-limited.
- **Signed download tokens** — HMAC-SHA256, constant-time verified, 1-hour expiry. For private-file downloads.

## Storage model

- **SQLite** (embedded, via Prisma) — fast local index, instant reads, single-node.
- **Telegram** — durable backup. Every record is mirrored as a structured message in the user's chat (their own bot or the server-side shared bot). Append-only, replayable.
- **Identity manifest** — a pinned Telegram message recording \`user → API keys → collections → records\`; re-pinned after every write so the platform self-heals after a full reset.
- **Realtime** — Socket.io on port 3003 pushes \`record:changed\` events; no polling.

## File limits (Telegram Bot API, accurate)

- **Upload via cloud Bot API** (\`sendDocument\` / \`sendVideo\` / …): **50 MB** max per file.
- **Download via \`getFile\`** (cloud): **20 MB** max — \`getFile\` only returns a \`file_path\` for files ≤ 20 MB.
- **2 GB upload + 2 GB download**: only with a self-hosted [Local Bot API Server](https://github.com/tdlib/telegram-bot-api). **Onyx Base does NOT currently support this** — roadmap (operator-configurable \`TELEGRAM_BOT_API_URL\`).

The 2 GB ceiling is enforced app-side either way; without a local Bot API server, uploads > 50 MB and downloads > 20 MB fail at the Telegram layer.

## CLI quick reference

\`\`\`bash
npm i -g onyx-base
export ONYX_URL=https://onyx.example.com
onyx login --name "Ada" --email ada@example.com   # create / connect
onyx set <key> <value> [--collection X]            # store (auto-typed)
onyx get <key>      [--collection X]               # read (stdout = value only)
onyx list [-v] · onyx delete <key> · onyx export   # list / remove / dump
onyx upload <path> [--label L] · onyx files · onyx download <id>
onyx file-link <id> · onyx file-revoke <id> · onyx file-delete <id>
onyx share --key <k> --mode read --ttl 3600 · onyx share --list · onyx share --revoke <id>
onyx collections [--create <name>] · onyx stats · onyx logs · onyx whoami · onyx health
onyx api-keys · onyx telegram-config · onyx admin  # management
\`\`\`

Config: \`~/.onyx/config.json\` (0600). \`get\`/\`list\` keep stdout pipe-clean.

## Feature inventory (Supabase-style mapping)

- **Security** — RLS: per-userId data isolation on every query (Equivalent). Policies: API-key scoping + share-token scope field (Equivalent). JWT verify: signed download tokens, HMAC-SHA256 constant-time (Equivalent). SSL: HTTPS at Caddy gateway + HSTS (Equivalent). Vault: all secrets in .env, gitignored (Equivalent). Audit logs: every write/login/admin action in \`logs\` table + Telegram mirror (Implemented). Network restrictions / IP allow-lists: Roadmap.
- **Database** — Managed PostgreSQL: N/A (we use SQLite + Telegram). PITR: Equivalent (Telegram mirror is append-only, replayable). Backups: Implemented (every record mirrored; manifest pinned). SQL editor: Implemented (read-only SELECT console against user-scoped virtual tables — records, collections, api_keys, logs, users — 1000-row cap, API keys masked). Triggers: Equivalent (event system fires \`record:changed\` via WebSocket + Telegram mirror). Branching / functions / views / materialized views: Roadmap. Read replicas / connection pooling / FDW: N/A (embedded SQLite).
- **Data API** — REST API: Implemented (\`/v1/*\`). Auto-generated RESTful API: every collection auto-exposes \`/v1/set\` \`/v1/get\` \`/v1/delete\` \`/v1/list\` (Implemented). Realtime API: WebSocket on :3003 pushes \`record:changed\` (Implemented). API keys: \`kv_live_*\`, per-user, revocable, named (Implemented). JWT auth: signed download tokens (Equivalent). Automatic RLS-by-default: every new collection is immediately accessible via \`/v1/*\` with per-userId isolation (Equivalent). GraphQL / OpenAPI / RPC: Roadmap.

## More info

- Full endpoint references with cURL / JS / Python / CLI examples: in-app **Docs** tab (also has a "Copy for LLMs" button that fetches this file).
- Telegram Bot API file limits: <https://core.telegram.org/bots/api#sending-files>
- Local Bot API server: <https://github.com/tdlib/telegram-bot-api>
- llms.txt convention: <https://llmstxt.org>
`

export async function GET() {
  return new NextResponse(LLMS_TXT, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
