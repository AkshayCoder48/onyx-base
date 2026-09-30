# Assistant and deployment notes

This change extends the original Onyx Base repository. Its Telegram-backed KV, file, auth, REST, CLI and dashboard code remain in place.

## Assistant

Open **AI Assistant** in the signed-in dashboard. The server route `/api/dashboard/assistant` requires the existing Bearer session key. It exposes account-scoped tools for statistics, collections, records, file metadata and activity, plus set/delete record operations. Writes and deletes are returned as reviewable actions and are only executed after the user confirms them in the UI. Existing key scopes are checked before tool execution — on the planning pass AND again on the confirmation pass, so a restricted key cannot be escalated mid-conversation. Telegram bot credentials and raw download links are not included in file-listing results. No server-side chat history is kept; the transcript lives in the browser only.

Set `OPENAI_API_KEY` server-side to enable natural-language tool selection using `gpt-4o-mini` by default. Optional `OPENAI_MODEL` and `OPENAI_BASE_URL` select another OpenAI-compatible chat-completions provider. The planner has a 9-second timeout and falls back to the deterministic parser on any failure. Without a key, the route uses a zero-token deterministic command parser for common commands (e.g. `show stats`, `list records`, `get record foo`, `set foo to 42`, `delete record foo`). No browser bundle contains the AI key.

The assistant UI follows the existing Sunrise Glass design system (coral/amber accents, warm ink text, `prefers-reduced-motion` support).

## Storage and deployment

For durable Telegram-backed data, configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CLOUDKV_SECRET` and other secrets as shown in the repository `.env.example`. SQLite-backed legacy SQL editor functions use `ONYX_SQLITE_URL` (default `file:./onyx-sql.db` locally, `file:/tmp/onyx-sql.db` on Vercel); a platform PostgreSQL `DATABASE_URL` is never passed to Prisma's SQLite driver. The V5 engine retains its existing `V5_DATABASE_URL` configuration; use a remotely durable libsql URL for multi-instance serverless deployments.

The optional Drizzle PostgreSQL workspace (`src/db/` + `drizzle.config.json`) is ready for future relational features: define tables in `src/db/schema.ts` and run `bunx drizzle-kit push` against a `postgres://` `DATABASE_URL`. It is inert by default — importing it never connects and never throws.

No Next.js application can guarantee zero provider CPU, zero function storage, or zero network latency. Telegram writes and freshness probes require real network round trips and Telegram's service limits apply. Local filesystem-backed indexes are ephemeral on most serverless hosts; use the repo's documented remote/durable configuration for production. CSS entrance motion uses short compospositor-friendly transforms and honors `prefers-reduced-motion`.
