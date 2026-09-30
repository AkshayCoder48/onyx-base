// Onyx Base — optional Drizzle (node-postgres) client.
//
// Purpose: a ready-to-use PostgreSQL workspace for future features that
// outgrow SQLite/Telegram (e.g. heavy relational queries, external
// analytics). It is deliberately OPTIONAL and inert by default:
//
//   - The pool is created lazily on first `getDb()` / `pool` access —
//     importing this module never connects and never throws. (A platform
//     DATABASE_URL may legitimately be a SQLite `file:` URL for the Prisma
//     SQL editor, or missing entirely on minimal deployments.)
//   - If DATABASE_URL is absent or not a PostgreSQL URL, callers get a
//     clear error instead of a crash at import time.
//   - The pool is cached on globalThis outside production so Next.js dev
//     hot-reload doesn't exhaust connections.
//
// Usage:
//   import { getDb } from '@/db'
//   const db = await getDb()           // drizzle instance bound to the pool
//   const rows = await db.select()...  // tables from './schema'
//
// Schema migrations: define tables in ./schema.ts, then
//   bunx drizzle-kit push        (drizzle.config.json)

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

const globalForDb = globalThis as typeof globalThis & {
  __onyxPgPool?: Pool
  __onyxPgDb?: NodePgDatabase<typeof schema>
}

function isPostgresUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^postgres(ql)?:\/\//i.test(url)
}

/** The shared PostgreSQL pool (lazily created; cached across hot reloads). */
export function getPool(): Pool {
  if (globalForDb.__onyxPgPool) return globalForDb.__onyxPgPool
  const url = process.env.DATABASE_URL
  if (!isPostgresUrl(url)) {
    throw new Error(
      'The optional PostgreSQL workspace requires DATABASE_URL to be a postgres:// URL. ' +
        'Set one (or leave this workspace unused — the rest of Onyx Base does not need it).',
    )
  }
  const pool = new Pool({ connectionString: url, max: 5 })
  if (process.env.NODE_ENV !== 'production') globalForDb.__onyxPgPool = pool
  return pool
}

/** Drizzle instance bound to the shared pool. Throws a clear error when no PostgreSQL URL is configured. */
export function getDb(): NodePgDatabase<typeof schema> {
  if (globalForDb.__onyxPgDb) return globalForDb.__onyxPgDb
  const db = drizzle(getPool(), { schema })
  if (process.env.NODE_ENV !== 'production') globalForDb.__onyxPgDb = db
  return db
}

// Kept for parity with the common `import { db, pool } from '@/db'` pattern.
// Property access triggers lazy creation, so merely importing the module
// stays side-effect free.
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>
    const value = Reflect.get(real, prop)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value
  },
})
export const pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const real = getPool() as unknown as Record<string | symbol, unknown>
    const value = Reflect.get(real, prop)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value
  },
})
