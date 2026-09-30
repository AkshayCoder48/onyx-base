# AI Assistant V2 (V6 Ultima) & Deployment

## AI Assistant V2 — zero-server intelligence

Open **AI Assistant** in the signed-in dashboard. The entire agent runs
**in your browser** — the deployment provider spends **zero CPU on
intelligence** and stores **zero assistant state**:

- **The agent loop is client-side** (`src/lib/v6/agent.ts`). Planning,
  tool-calling, and summarizing all happen in the browser.
- **Bring your own key (BYOK)**: connect any OpenAI-compatible provider
  (OpenAI, OpenRouter, Groq, LM Studio…) in the assistant's ⚙ settings.
  The key is saved in `localStorage` and sent **directly to the provider**
  — it never reaches OnyxBase servers. Without a key, a built-in
  deterministic planner covers the full command grammar with no LLM at all.
- **Transcript lives in localStorage** (per user) — no server-side chat
  history, ever.
- **The old server route is gone**: `/api/dashboard/assistant` was removed;
  there is no server-side AI path left in the codebase.

### Tools — the whole app

Read tools: `stats`, `analytics`, `records`, `get_record`, `collections`,
`api_keys`, `share_tokens`, `files`, `logs`, `email_credentials`,
`telegram_status`, `diagnostics`.
Write tools (always confirmation-gated): `set_record`, `delete_record`,
`create_collection`, `delete_collection`, `create_api_key`,
`revoke_api_key`, `create_share_token`, `revoke_share_token`,
`delete_file`, `revoke_file_link`, `send_email`.
Client-side action tools: `navigate` (switch dashboard tabs — zero network).

Reads are **cache-first**: when the V6 instant cache is fresh (see below),
a read tool answers with **zero server round trips**.

### Safety model

A mutation is NEVER executed during planning. The agent loop pauses with a
`confirm_required` event; the UI shows a review card with the exact tool
and arguments; only an explicit user confirmation executes it (and queued
follow-up mutations each get their own card). Multi-step plans keep a
queue and pause at every write. Per-key scopes/collection allow-lists are
enforced by the underlying REST endpoints exactly as if the user clicked
the dashboard UI.

### Command grammar (built-in planner)

`show stats` · `list records` · `get record foo` · `set foo to 42` ·
`set foo in cache to {"a":1}` · `delete record foo` · `create collection cache` ·
`create api key ci-bot` · `create share token for leaderboard` ·
`list share tokens` · `show files` · `show logs` · `show analytics` ·
`send email via personal_email to a@b.com …` · `open the analytics tab` · `help`

## V6 Ultima — the instant-access architecture

**Server** (`src/lib/v6.ts`, `/api/v6/*`):

- **ETag/304 on every dashboard read** (`records`, `stats`, `api-keys`,
  `collections`, `logs`, `analytics`, `share-tokens`): the tag is a SHA-256
  of the canonical response payload. Unchanged data → `304 Not Modified`
  with an empty body — the fastest possible round trip.
- **`GET /api/v6/boot`** — ONE request returns everything the dashboard
  needs (session, records, stats, analytics, collections, api keys, share
  tokens, recent logs), with an ETag: send `If-None-Match` and an unchanged
  workspace answers `304` → the client boots fully instantly from its
  cached copy with zero payload transfer.
- **`POST /api/v6/batch`** — up to 25 KV operations (get/set/delete/list)
  in one function invocation, per-op authorized, per-op results. The
  assistant's low-invocation transport.

**Client** (`src/lib/v6/ultima.ts`):

- **Instant paint**: the last boot payload is persisted in localStorage
  (namespaced per user) and seeded into the React Query cache
  SYNCHRONOUSLY before the dashboard renders — tabs open with data on
  screen at frame one, no spinners.
- **One boot round trip** with `If-None-Match`; 304 → cached payload is
  re-stamped fresh.
- **Instant search**: records/logs hold ONE base query each; collection
  filters and search boxes are pure client-side derivations — zero network
  per keystroke.
- **Optimistic writes**: set/delete update the local cache first (UI
  reflects the change instantly), the network confirms after, and failures
  roll back to the exact pre-mutation snapshot.

## Deployment

`vercel.json` pins the build (`next build`, `bun install`). Deploys are
automatic from `main` on GitHub. The Cloudflare Pages path
(`scripts/build-pages-worker.mjs`) is unchanged.

The assistant UI follows the Sunrise Glass design system (coral/amber
accents, warm ink text, `prefers-reduced-motion` support), extended with
the V6 Ultima motion system (motion-blur entrances, directional view
slides, time-sliced staggers — see `globals.css`).
