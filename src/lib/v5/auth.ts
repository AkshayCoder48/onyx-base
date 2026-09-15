/**
 * OnyxBase V5 — authentication (docs/v5-contract.md).
 *
 * Bearer keys resolve with ONE indexed SQLite lookup on v5_accounts — no
 * Telegram rehydration, no in-memory store dependency, instant on cold boot.
 *
 * Seeding: every key in V5_MASTER_API_KEYS (comma-separated env) maps to the
 * shared `master` service account (multiple keys, one owner — the V4 model).
 * BOOTSTRAP_ADMIN_KEY additionally seeds an `admin` account.
 *
 * Per-user accounts are created via POST /api/v5/accounts (public) — each is
 * its own owner; keys are stored as sha256(key + salt) and are only ever
 * shown once at creation/login.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from '@/lib/password'
import { v5db, nowMs, num } from './db'

const SALT = process.env.V5_KEY_SALT || 'onyxbase-v5-default-salt-change-me'

export interface V5Account {
  id: string
  owner: string
  email: string | null
  name: string | null
  role: 'user' | 'admin'
}

function keyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey.trim() + SALT).digest('hex')
}

export function mintApiKey(): string {
  return `kv_live_${randomBytes(24).toString('hex')}`
}

let seeded = false

/** Idempotently seed master/admin accounts from env. Safe to call often. */
export async function ensureSeeded(): Promise<void> {
  if (seeded) return
  const now = nowMs()
  const rows: Array<{ owner: string; role: 'master' | 'admin'; key: string }> = []
  const masters = (process.env.V5_MASTER_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
  for (const k of masters) rows.push({ owner: 'master', role: 'master', key: k })
  const boot = (process.env.BOOTSTRAP_ADMIN_KEY || '').trim()
  if (boot.length > 8) rows.push({ owner: 'admin', role: 'admin', key: boot })
  if (rows.length > 0) {
    const db = await v5db()
    await db.batch(
      rows.map((r) => ({
        sql: `INSERT INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, created_at, updated_at)
              VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
              ON CONFLICT(api_key_hash) DO NOTHING`,
        args: [`${r.role}_${keyHash(r.key).slice(0, 16)}`, r.owner, keyHash(r.key), r.role, r.role, now, now],
      })),
      'write'
    )
  }
  seeded = true
}

function rowToAccount(row: Record<string, unknown>): V5Account {
  return {
    id: String(row.owner_key),
    owner: String(row.owner_key),
    email: (row.email as string) ?? null,
    name: (row.name as string) ?? null,
    role: row.role === 'admin' || row.role === 'master' ? 'admin' : 'user',
  }
}

/** Resolve a Bearer header to a V5 account (null = invalid/missing). */
export async function v5AuthBearer(header: string | null): Promise<V5Account | null> {
  if (!header || !/^Bearer\s+.+/i.test(header)) return null
  const apiKey = header.replace(/^Bearer\s+/i, '').trim()
  if (!apiKey) return null
  await ensureSeeded()
  const db = await v5db()
  const rs = await db.execute({
    sql: `SELECT owner_key, email, name, role FROM v5_accounts WHERE api_key_hash = ? LIMIT 1`,
    args: [keyHash(apiKey)],
  })
  if (rs.rows.length === 0) return null
  return rowToAccount(rs.rows[0] as Record<string, unknown>)
}

// ─── Account register / login (public endpoints) ─────────────────────────────

export interface AccountResult {
  userId: string
  apiKey: string
  name: string
  email: string
}

/**
 * Register an account. Idempotency: when idemKey is provided and a previous
 * registration with the same key exists, mint a FRESH api key for that SAME
 * account (keys are re-mintable, never recoverable) and return it.
 */
export async function v5Register(opts: {
  name: string
  email: string
  password: string
  idemKey?: string
}): Promise<AccountResult> {
  await ensureSeeded()
  const db = await v5db()
  const now = nowMs()
  const emailLower = opts.email.toLowerCase().trim()

  // Idempotent replay: same registration attempt → same account, fresh key.
  if (opts.idemKey) {
    const rs = await db.execute({
      sql: `SELECT id, name, email, password_hash FROM v5_accounts WHERE idem_register = ? LIMIT 1`,
      args: [opts.idemKey],
    })
    if (rs.rows.length > 0) {
      const row = rs.rows[0] as Record<string, unknown>
      const fresh = mintApiKey()
      await db.execute({
        sql: `INSERT INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, created_at, updated_at)
              VALUES (?, ?, ?, ?, NULL, ?, ?, 'user', ?, ?)`,
        args: [
          `key_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          String(row.id),
          keyHash(fresh),
          String(row.email ?? ''),
          row.password_hash as string,
          String(row.name ?? ''),
          now,
          now,
        ],
      })
      return {
        userId: String(row.id),
        apiKey: fresh,
        name: String(row.name ?? ''),
        email: String(row.email ?? emailLower),
      }
    }
  }

  const existing = await db.execute({
    sql: `SELECT id FROM v5_accounts WHERE email_lower = ? LIMIT 1`,
    args: [emailLower],
  })
  if (existing.rows.length > 0) {
    throw Object.assign(new Error('This email is already registered.'), { code: 'EMAIL_TAKEN' })
  }

  const id = `usr_${randomUUID().replace(/-/g, '').slice(0, 10)}`
  const apiKey = mintApiKey()
  const pwh = hashPassword(opts.password)
  await db.batch(
    [
      {
        sql: `INSERT INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, created_at, updated_at, idem_register)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
        args: [id, id, keyHash(apiKey), opts.email.trim(), emailLower, pwh, opts.name.trim(), now, now, opts.idemKey ?? null],
      },
    ],
    'write'
  )
  return { userId: id, apiKey, name: opts.name.trim(), email: opts.email.trim() }
}

/** Login: verify credentials → mint a fresh api key for the account. */
export async function v5Login(email: string, password: string): Promise<AccountResult> {
  await ensureSeeded()
  const db = await v5db()
  const emailLower = email.toLowerCase().trim()
  const rs = await db.execute({
    sql: `SELECT id, password_hash, name, email FROM v5_accounts WHERE email_lower = ? LIMIT 1`,
    args: [emailLower],
  })
  if (rs.rows.length === 0) {
    throw Object.assign(new Error('Invalid email or password.'), { code: 'AUTH_INVALID_CREDENTIALS' })
  }
  const row = rs.rows[0] as Record<string, unknown>
  if (!verifyPassword(password, row.password_hash as string | null)) {
    throw Object.assign(new Error('Invalid email or password.'), { code: 'AUTH_INVALID_CREDENTIALS' })
  }
  const now = nowMs()
  const fresh = mintApiKey()
  await db.execute({
    sql: `INSERT INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, 'user', ?, ?)`,
    args: [
      `key_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      String(row.id),
      keyHash(fresh),
      String(row.email ?? ''),
      row.password_hash as string,
      String(row.name ?? ''),
      now,
      now,
    ],
  })
  return { userId: String(row.id), apiKey: fresh, name: String(row.name ?? ''), email: String(row.email ?? emailLower) }
}

export { num }
