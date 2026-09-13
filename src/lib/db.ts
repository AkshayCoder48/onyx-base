import type { PrismaClient } from '@prisma/client'

// ─── Lazy Prisma initialization ─────────────────────────────────────────────
//
// WHY LAZY: On Cloudflare Workers/Pages the filesystem is read-only, so
// Prisma's SQLite engine cannot connect to `file:.../custom.db`. If we
// instantiated `new PrismaClient()` at module load it would crash every
// cold start. Instead we defer creation until the first actual query — so
// the core app (KV store + Telegram sync + auth + files, which uses the
// in-memory `data-store.ts`, NOT Prisma) boots and runs without ever
// touching Prisma. The SQL Editor / Tables / Views / Functions features
// (which DO use Prisma) will surface a clean error when called on
// serverless runtimes that lack a writable SQLite file.
//
// The dynamic `import('@prisma/client')` also keeps the Prisma WASM engine
// OUT of the main bundle — it is only loaded if a SQL feature is actually
// invoked, which keeps the Cloudflare bundle small.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

let prismaPromise: Promise<PrismaClient> | null = null

function getPrisma(): Promise<PrismaClient> {
  if (prismaPromise) return prismaPromise
  if (globalForPrisma.prisma) {
    prismaPromise = Promise.resolve(globalForPrisma.prisma)
    return prismaPromise
  }
  prismaPromise = (async () => {
    const mod = await import('@prisma/client')
    const instance = new mod.PrismaClient({ log: ['query'] })
    if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = instance
    return instance
  })().catch((err) => {
    // Reset so the next call retries; re-throw so the caller sees the error.
    prismaPromise = null
    throw err
  })
  return prismaPromise
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime schema bootstrap (idempotent, lazy).
//
// WHY: on serverless platforms (Vercel / Cloudflare) `prisma db push` /
// `migrate deploy` never run, and the SQLite file is a fresh empty file on
// every cold start. Without these tables, every SQL Editor / Tables / Views
// query would fail with "no such table". CREATE TABLE IF NOT EXISTS is a
// no-op locally (the tables already exist from `bun run db:push`) and
// creates them on-demand in the serverless /tmp database.
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

const schemaReadyMap = new WeakMap<PrismaClient, Promise<void>>()

function ensureSchema(prisma: PrismaClient): Promise<void> {
  const existing = schemaReadyMap.get(prisma)
  if (existing) return existing
  const p = (async () => {
    try {
      for (const stmt of SCHEMA_DDL) {
        await prisma.$executeRawUnsafe(stmt)
      }
    } catch (err) {
      // Log but never crash the request — the caller will see the query error.
      console.error('[db] runtime schema init failed:', err)
      throw err
    }
  })()
  schemaReadyMap.set(prisma, p)
  return p
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy model proxies.
//
// WHY: routes like /api/v1/views do `db.view.findMany(...)`. The lazy Proxy
// below used to return `undefined` for any non-raw-query property, which made
// `db.view.findMany` throw `Cannot read properties of undefined` → HTTP 500
// on every views / matviews / functions request. We now return a per-model
// sub-proxy that (a) instantiates the real PrismaClient on first use,
// (b) ensures the SQLite schema exists, then (c) forwards the method call.
//
// The sub-proxies are cached so `db.view === db.view` (identity is stable and
// each model's methods are only re-bound once).
// ─────────────────────────────────────────────────────────────────────────────
const modelProxies = new Map<string, unknown>()

function getModelProxy(prop: string): unknown {
  const cached = modelProxies.get(prop)
  if (cached) return cached

  const sub = new Proxy({} as Record<string, unknown>, {
    get(_t, method) {
      if (typeof method !== 'string') return undefined
      // Async, lazily-resolving method wrapper (findMany, create, …).
      return async (...args: unknown[]) => {
        const prisma = await getPrisma()
        await ensureSchema(prisma)
        const model = Reflect.get(prisma, prop) as Record<string, unknown> | undefined
        if (!model || typeof model !== 'object') {
          throw new Error(`Prisma model "${prop}" does not exist on the generated client`)
        }
        const fn = Reflect.get(model, method)
        if (typeof fn !== 'function') {
          throw new Error(`Prisma model "${prop}.${method}" is not a function`)
        }
        return (fn as (...a: unknown[]) => unknown).apply(model, args)
      }
    },
  })

  modelProxies.set(prop, sub)
  return sub
}

// Wrap the raw-query methods so the schema is ensured before the first query
// AND PrismaClient is lazily instantiated. Non-query property access resolves
// to a lazy model sub-proxy (see getModelProxy).
const RAW_QUERY_METHODS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction',
])

/**
 * Lazy Prisma client. PrismaClient is instantiated + the SQLite schema is
 * ensured on the FIRST raw query OR model-method call, not at module load.
 * This is critical for Cloudflare (read-only filesystem) and serverless
 * cold-start performance.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (typeof prop !== 'string') return undefined
    if (RAW_QUERY_METHODS.has(prop)) {
      return async (...args: unknown[]) => {
        const prisma = await getPrisma()
        await ensureSchema(prisma)
        const method = Reflect.get(prisma, prop, receiver)
        if (typeof method === 'function') {
          return method.apply(prisma, args)
        }
        throw new Error(`Prisma method "${prop}" is not a function`)
      }
    }
    // Non-function symbols (e.g. Symbol.toPrimitive / util.inspect.custom)
    // should not create model proxies.
    return getModelProxy(prop)
  },
})
