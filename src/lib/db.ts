import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const basePrisma = globalForPrisma.prisma ?? new PrismaClient({ log: ['query'] })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma

// ─────────────────────────────────────────────────────────────────────────────
// Runtime schema bootstrap (idempotent, lazy).
//
// WHY: on serverless platforms (Vercel) `prisma db push` / `migrate deploy`
// never run, and the SQLite file is a fresh empty file on every cold start.
// Without these tables, every SQL Editor / Tables / Views query would fail
// with "no such table". CREATE TABLE IF NOT EXISTS is a no-op locally (the
// tables already exist from `bun run db:push`) and creates them on-demand in
// the serverless /tmp database.
//
// The DDL mirrors prisma/schema.prisma exactly. If the schema changes, update
// both files.
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "User" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT, "email" TEXT, "plan" TEXT NOT NULL DEFAULT 'free', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "User_userId_key" ON "User"("userId")`,
  `CREATE TABLE IF NOT EXISTS "ApiKey" ("id" TEXT NOT NULL PRIMARY KEY, "key" TEXT NOT NULL, "name" TEXT NOT NULL DEFAULT 'default', "userId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastUsedAt" DATETIME, "revoked" BOOLEAN NOT NULL DEFAULT false, FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_key_key" ON "ApiKey"("key")`,
  `CREATE INDEX IF NOT EXISTS "ApiKey_userId_idx" ON "ApiKey"("userId")`,
  `CREATE TABLE IF NOT EXISTS "Collection" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "userId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Collection_userId_name_key" ON "Collection"("userId", "name")`,
  `CREATE INDEX IF NOT EXISTS "Collection_userId_idx" ON "Collection"("userId")`,
  `CREATE TABLE IF NOT EXISTS "Record" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "collectionId" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL, "valueType" TEXT NOT NULL DEFAULT 'string', "telegramMessageId" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE, FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Record_collectionId_key_key" ON "Record"("collectionId", "key")`,
  `CREATE INDEX IF NOT EXISTS "Record_userId_idx" ON "Record"("userId")`,
  `CREATE INDEX IF NOT EXISTS "Record_collectionId_key_idx" ON "Record"("collectionId", "key")`,
  `CREATE TABLE IF NOT EXISTS "Log" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "action" TEXT NOT NULL, "key" TEXT, "detail" TEXT, "source" TEXT NOT NULL DEFAULT 'api', "ip" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS "Log_userId_idx" ON "Log"("userId")`,
  `CREATE INDEX IF NOT EXISTS "Log_createdAt_idx" ON "Log"("createdAt")`,
  `CREATE TABLE IF NOT EXISTS "View" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "collection" TEXT NOT NULL, "projection" TEXT NOT NULL, "filter" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "View_userId_name_key" ON "View"("userId", "name")`,
  `CREATE INDEX IF NOT EXISTS "View_userId_idx" ON "View"("userId")`,
  `CREATE TABLE IF NOT EXISTS "Function" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "code" TEXT NOT NULL, "trigger" TEXT NOT NULL DEFAULT 'manual', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Function_userId_name_key" ON "Function"("userId", "name")`,
  `CREATE INDEX IF NOT EXISTS "Function_userId_idx" ON "Function"("userId")`,
  `CREATE TABLE IF NOT EXISTS "MaterializedView" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "query" TEXT NOT NULL, "result" TEXT NOT NULL, "lastRefreshedAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MaterializedView_userId_name_key" ON "MaterializedView"("userId", "name")`,
  `CREATE INDEX IF NOT EXISTS "MaterializedView_userId_idx" ON "MaterializedView"("userId")`,
  `CREATE TABLE IF NOT EXISTS "UserTable" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "tableName" TEXT NOT NULL, "accessMode" TEXT NOT NULL DEFAULT 'readwrite', "schema" TEXT NOT NULL, "rowCount" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UserTable_userId_name_key" ON "UserTable"("userId", "name")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UserTable_tableName_key" ON "UserTable"("tableName")`,
  `CREATE INDEX IF NOT EXISTS "UserTable_userId_idx" ON "UserTable"("userId")`,
]

let schemaInitialized = false
let schemaPromise: Promise<void> | null = null

async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return
  if (!schemaPromise) {
    schemaPromise = (async () => {
      try {
        for (const stmt of SCHEMA_DDL) {
          await basePrisma.$executeRawUnsafe(stmt)
        }
        schemaInitialized = true
      } catch (err) {
        // Reset so the next call retries; log but never crash the request.
        console.error('[db] runtime schema init failed:', err)
        schemaPromise = null
      }
    })()
  }
  await schemaPromise
}

// Wrap the raw-query methods so the schema is ensured before the first query.
// This is lazy (runs on first actual query, NOT at module load) so it is safe
// during `next build` page-data collection. Non-query property access passes
// through unchanged.
const RAW_QUERY_METHODS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction',
])

export const db = new Proxy(basePrisma, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (
      typeof prop === 'string' &&
      RAW_QUERY_METHODS.has(prop) &&
      typeof value === 'function'
    ) {
      const bound = value.bind(target)
      // Return a function that ensures the schema, then forwards the call.
      // The original method already returns a Promise, so the chain resolves
      // to the query result.
      return (...args: unknown[]) => ensureSchema().then(() => bound(...args))
    }
    return value
  },
})
