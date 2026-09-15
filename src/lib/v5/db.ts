/**
 * OnyxBase V5 — database engine (docs/v5-contract.md).
 *
 * SQLite is AUTHORITATIVE for V5. One driver (@libsql/client) serves both
 * deployment modes:
 *   - `file:./.data/v5.db`    → local SQLite (self-host / dev) with WAL.
 *   - `libsql://…` (+ token)  → Turso (serverless / Vercel) — remotely durable.
 *
 * Telegram is an ASYNC durability mirror only — never in the request path.
 */

import { createClient, type Client } from '@libsql/client'

const V5_DATABASE_URL = process.env.V5_DATABASE_URL || ''
const V5_DATABASE_AUTH_TOKEN = process.env.V5_DATABASE_AUTH_TOKEN || ''

const globalForV5 = globalThis as unknown as {
  __v5Client?: Client
  __v5Ready?: Promise<Client>
  __v5BootRestore?: Promise<unknown>
}

export function v5Configured(): boolean {
  return V5_DATABASE_URL.length > 0
}

/** DDL per docs/v5-contract.md — idempotent. */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS v5_accounts (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    email TEXT,
    email_lower TEXT,
    password_hash TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    idem_register TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v5_accounts_key ON v5_accounts(api_key_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v5_accounts_email ON v5_accounts(email_lower) WHERE email_lower IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v5_accounts_idem ON v5_accounts(idem_register) WHERE idem_register IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS v5_kv (
    owner TEXT NOT NULL,
    collection TEXT NOT NULL DEFAULT 'default',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (owner, collection, key)
  )`,
  `CREATE INDEX IF NOT EXISTS v5_kv_scan ON v5_kv(owner, collection, deleted_at, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS v5_counters (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, name)
  )`,
  `CREATE TABLE IF NOT EXISTS v5_ops (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    type TEXT NOT NULL,
    idem_key TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    request_json TEXT,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    duration_ms INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v5_ops_idem ON v5_ops(owner, type, idem_key) WHERE idem_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS v5_ops_recent ON v5_ops(owner, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS v5_blobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    filename TEXT,
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    checksum TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    storage_key TEXT,
    chunks INTEGER NOT NULL DEFAULT 0,
    is_public INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS v5_blobs_owner ON v5_blobs(owner, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS v5_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    type TEXT NOT NULL,
    subject TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS v5_events_owner ON v5_events(owner, id)`,
]

function newClient(): Client {
  const url = V5_DATABASE_URL.trim()
  const c = createClient({
    url,
    authToken: V5_DATABASE_AUTH_TOKEN || undefined,
    // Keep idle sockets warm for the server lifetime.
    ...(url.startsWith('file:')
      ? {}
      : { concurrency: 8 }),
  })
  return c
}

async function init(): Promise<Client> {
  const c = globalForV5.__v5Client ?? newClient()
  globalForV5.__v5Client = c
  const isFile = V5_DATABASE_URL.trim().startsWith('file:')
  const setup: string[] = isFile
    ? ['PRAGMA journal_mode=WAL', 'PRAGMA synchronous=NORMAL', 'PRAGMA busy_timeout=5000']
    : ['PRAGMA busy_timeout=5000']
  for (const stmt of setup) {
    try {
      await c.execute(stmt)
    } catch {
      /* pragma best-effort */
    }
  }
  for (const stmt of DDL) await c.execute(stmt)

  // Cold-boot recovery ("Telegram = data saver"): when the store is EMPTY and
  // a Telegram snapshot exists, rebuild automatically. bootRestoreIfEmpty()
  // itself owns the globalThis promise (never store THIS import chain on the
  // slot — a chain that resolves to itself deadlocks).
  if (isV5TelegramBackupEnabled()) {
    void import('./backup')
      .then((m) => m.bootRestoreIfEmpty())
      .catch((err) => {
        console.warn(
          JSON.stringify({ t: new Date().toISOString(), operation: 'v5.db.init', level: 'warn', error: err instanceof Error ? err.message : String(err) }),
        )
      })
  }

  return c
}

/**
 * Trigger init (which arms the boot restore) and await its completion.
 * Called by the request handler so the FIRST request after a cold boot
 * sees restored data; resolves instantly once initialized. The setTimeout(0)
 * yields one macrotask so the dynamic import's microtask chain can store
 * the restore promise before we look for it.
 */
export async function v5EnsureBootRestore(): Promise<void> {
  if (!v5Configured() || !isV5TelegramBackupEnabled()) return
  try {
    await v5db()
  } catch {
    return
  }
  if (!globalForV5.__v5BootRestore) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const p = globalForV5.__v5BootRestore
  if (p) await p
}

/** The singleton, schema-bootstrapped V5 client. */
export function v5db(): Promise<Client> {
  if (!v5Configured()) {
    return Promise.reject(new Error('V5_DATABASE_URL is not configured'))
  }
  if (!globalForV5.__v5Ready) {
    globalForV5.__v5Ready = init().catch((err) => {
      globalForV5.__v5Ready = undefined
      throw err
    })
  }
  return globalForV5.__v5Ready
}

/** Health ping — latency of a trivial SELECT. */
export async function v5Ping(): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = Date.now()
  try {
    await (await v5db()).execute('SELECT 1 AS ok')
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 }
  }
}

export function isFileMode(): boolean {
  return V5_DATABASE_URL.trim().startsWith('file:')
}

/** Is the async Telegram backup mirror enabled (V5_TELEGRAM_BACKUP)? */
export function isV5TelegramBackupEnabled(): boolean {
  return process.env.V5_TELEGRAM_BACKUP !== 'false'
}

export function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function nowMs(): number {
  return Date.now()
}
