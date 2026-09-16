/**
 * POST /api/v5/admin/migrate-v4-accounts — one-time V4→V5 account migration.
 *
 * WHY: legacy V4-era users exist only in the Telegram-backed V4 account
 * store (scrypt password hashes + kv_live_* API keys). The Hub's V5 login
 * path can't see them, so the Hub used to fall back to the V4 layer for
 * every failed V5 login — a fallback that costs a full Telegram index fetch
 * + per-account manifest rehydrate on the engine (heavy CPU per wrong
 * password attempt). Migrating every V4 user INTO v5_accounts makes the V5
 * path authoritative for everyone, so the V4 fallback (and its CPU burn)
 * can be deleted from the Hub entirely.
 *
 * WHAT IT DOES (idempotent, master-only):
 *   1. Hydrates the V4 store (fresh pinned index + per-account manifests).
 *   2. For each V4 user with an email:
 *        - skip when a v5_accounts row already exists for that email
 *          (their current V5 password wins — never clobber);
 *        - insert a canonical v5_accounts row with id/owner_key = the V4
 *          public userId, the V4 scrypt password hash transplanted as-is
 *          (same `scrypt$salt$hash` format as V5 — zero re-hashing), and
 *          api_key_hash = hash(their existing V4 kv_live key) so old keys
 *          keep authenticating; when that hash collides with an existing
 *          row (e.g. the master key), a synthetic never-matching hash is
 *          used (login still mints fresh keys).
 *   3. Reports { total, migrated, skippedExisting, skippedNoEmail, keyCollisions }.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { v5db, nowMs } from '@/lib/v5/db'
import { createHash, randomUUID } from 'node:crypto'
import {
  fetchFreshIndex,
  rehydrateAccountFromTelegram,
  allUsersSnapshot,
  allApiKeysSnapshot,
} from '@/lib/data-store'
import { queueAuthSnapshot } from '@/lib/v5/backup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const SALT = process.env.V5_KEY_SALT || 'onyxbase-v5-default-salt-change-me'

function keyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey.trim() + SALT).digest('hex')
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique constraint|constraint failed/i.test(msg)
}

export const POST = withV5Handler({
  operation: 'admin.migrate_v4_accounts',
  auth: 'bearer',
  handler: async (_req: NextRequest, ctx) => {
    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Admin access required.', 401)
    }

    // 1. Hydrate the V4 store (fresh index + every account manifest).
    const idx = await fetchFreshIndex()
    if (!idx) {
      return ctx.ok({ hydrated: false, total: 0, migrated: 0, skippedExisting: 0, skippedNoEmail: 0, keyCollisions: 0, note: 'No V4 account index found — nothing to migrate.' })
    }
    const entries = Object.values(idx.accounts)
    for (const entry of entries) {
      try {
        await rehydrateAccountFromTelegram(entry.userId)
      } catch {
        /* best-effort — users that fail to hydrate simply won't be in the snapshot */
      }
    }

    const users = allUsersSnapshot().filter((u) => u.email && u.email.trim())
    // Never import test/e2e identities (they were purged from V5 on purpose).
    const isTestEmail = (e: string) =>
      e.endsWith('@rge-e2e.test') || e.endsWith('@example.com') || e.includes('e2e.')
    const migratable = users.filter((u) => !isTestEmail((u.email || '').trim().toLowerCase()))
    const keysByDbId = new Map<string, string>()
    for (const k of allApiKeysSnapshot()) {
      if (!keysByDbId.has(k.userId)) keysByDbId.set(k.userId, k.key)
    }

    const db = await v5db()
    const now = nowMs()
    let migrated = 0
    let skippedExisting = 0
    let keyCollisions = 0

    for (const u of migratable) {
      const email = (u.email || '').trim()
      const emailLower = email.toLowerCase()
      if (!emailLower) continue

      const existing = await db.execute({
        sql: `SELECT id FROM v5_accounts WHERE email_lower = ? LIMIT 1`,
        args: [emailLower],
      })
      if (existing.rows.length > 0) {
        skippedExisting++
        continue
      }

      // Their first non-revoked V4 key, if any — keeps old keys working.
      const v4Key = keysByDbId.get(u.id)
      let apiKeyHash = v4Key ? keyHash(v4Key) : keyHash(`__orphan_${u.id}_${randomUUID()}`)

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await db.execute({
            sql: `INSERT INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
            args: [
              u.userId,
              u.userId,
              apiKeyHash,
              email,
              emailLower,
              u.passwordHash,
              u.name ?? email.split('@')[0],
              now,
              now,
            ],
          })
          migrated++
          break
        } catch (err) {
          if (isUniqueViolation(err)) {
            if (attempt === 0 && v4Key) {
              // api_key_hash collision (key already seeded elsewhere) — use a
              // synthetic hash that no real key will ever produce; login mints
              // fresh keys for the account anyway.
              keyCollisions++
              apiKeyHash = keyHash(`__synthetic_${u.id}_${randomUUID()}`)
              continue
            }
            // id (userId) collision — keep the row that exists.
            skippedExisting++
            break
          }
          throw err
        }
      }
    }

    if (migrated > 0) queueAuthSnapshot()
    return ctx.ok({
      hydrated: true,
      v4Accounts: entries.length,
      total: migratable.length,
      migrated,
      skippedExisting,
      skippedTestEmails: users.length - migratable.length,
      skippedNoEmail: allUsersSnapshot().length - users.length,
      keyCollisions,
    })
  },
})
