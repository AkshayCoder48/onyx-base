// Onyx Base — optional Drizzle schema entrypoint.
//
// This workspace is intentionally separate from the app's core stores:
//   - Telegram-backed KV / files / accounts → src/lib/data-store.ts + v5 engine
//   - Legacy SQLite SQL editor (Prisma)     → prisma/schema.prisma + src/lib/db.ts
//   - Optional PostgreSQL workspace (Drizzle) → THIS directory
//
// Define Drizzle tables here and run `bunx drizzle-kit push` (config in
// drizzle.config.json) to apply them to a PostgreSQL database. Nothing in
// the app imports this file yet — it exists so the workspace is ready the
// moment a PostgreSQL-backed feature is needed, without bootstrapping
// tooling first.
export {}
