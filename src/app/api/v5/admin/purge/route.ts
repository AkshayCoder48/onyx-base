/**
 * /api/v5/admin/purge — deterministic test-data cleanup (admin/master only).
 *
 *   GET  → inventory: logical accounts, per-owner/collection KV counts,
 *          per-owner blob counts. Optional deep views for building an
 *          EXPLICIT delete list:
 *            ?collection=X&owner=Y        → keys (+values with &values=1)
 *            ?blobs=1&owner=Y             → blob ids + filenames + status
 *
 *   POST → { dryRun?, accounts?, kv?, blobs? } — every target is an EXPLICIT
 *          id/email/key (never a name pattern, so real users can never be
 *          caught by a heuristic). dryRun=true resolves and reports exactly
 *          what WOULD be deleted without touching anything.
 *
 *          accounts: user ids or emails → account rows + key rows deleted
 *                    (rides the accountsDel snapshot list so no instance ever
 *                    resurrects them) + all their KV + all their blobs.
 *          kv:       [{owner, collection, key}] → kvDelete (delta channel
 *                    propagates the tombstones within ~1-2s).
 *          blobs:    [blobId] → deletePartsBlob / deleteBlob (Telegram docs,
 *                    manifests, part records, dedup keys, row tombstone).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { v5db, num, nowMs } from '@/lib/v5/db'
import { kvDelete } from '@/lib/v5/kv'
import { getBlob, deleteBlob } from '@/lib/v5/blobs'
import { deletePartsBlob } from '@/lib/v5/blob-parts'
import { noteAccountDelete, noteBlobMetaDelete } from '@/lib/v5/backup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = withV5Handler({
  operation: 'admin.purge.inventory',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    if (ctx.user!.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Purge control requires an admin/master key.', 403)
    }
    const db = await v5db()
    const { searchParams } = new URL(req.url)

    // Deep view: KV keys for one owner/collection (values optional).
    const collection = searchParams.get('collection')
    const owner = searchParams.get('owner')
    if (collection && owner) {
      const wantValues = searchParams.get('values') === '1'
      const rs = await db.execute({
        sql: `SELECT key, value, updated_at FROM v5_kv WHERE owner = ? AND collection = ? AND deleted_at IS NULL ORDER BY key LIMIT 1000`,
        args: [owner, collection],
      })
      return ctx.ok({
        owner,
        collection,
        count: rs.rows.length,
        items: rs.rows.map((r) => {
          const row = r as Record<string, unknown>
          const out: Record<string, unknown> = { key: String(row.key), updatedAt: num(row.updated_at) }
          if (wantValues) {
            try {
              out.value = JSON.parse(String(row.value))
            } catch {
              out.value = String(row.value)
            }
          }
          return out
        }),
      })
    }

    // Deep view: blobs for one owner.
    if (searchParams.get('blobs') === '1') {
      const blobOwner = searchParams.get('owner') || '%'
      const rs = await db.execute({
        sql: `SELECT id, owner, filename, mime, size, status, created_at FROM v5_blobs WHERE owner LIKE ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1000`,
        args: [blobOwner],
      })
      return ctx.ok({
        owner: blobOwner,
        count: rs.rows.length,
        blobs: rs.rows.map((r) => {
          const row = r as Record<string, unknown>
          return {
            blobId: String(row.id),
            owner: String(row.owner),
            filename: row.filename === null ? null : String(row.filename),
            mimeType: row.mime === null ? null : String(row.mime),
            size: num(row.size),
            status: String(row.status),
            createdAt: num(row.created_at),
          }
        }),
      })
    }

    // Default inventory.
    const [accounts, kvCounts, blobCounts] = await Promise.all([
      db.execute(
        `SELECT id, owner_key, email, email_lower, name, role, created_at FROM v5_accounts
         WHERE id = owner_key OR owner_key IN ('master', 'admin')
         ORDER BY created_at ASC LIMIT 1000`,
      ),
      db.execute(
        `SELECT owner, collection, COUNT(*) AS n FROM v5_kv WHERE deleted_at IS NULL GROUP BY owner, collection ORDER BY owner, collection LIMIT 1000`,
      ),
      db.execute(
        `SELECT owner, status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM v5_blobs WHERE status != 'deleted' GROUP BY owner, status ORDER BY owner, status LIMIT 1000`,
      ),
    ])
    return ctx.ok({
      accounts: accounts.rows.map((r) => {
        const row = r as Record<string, unknown>
        return {
          id: String(row.id),
          ownerKey: String(row.owner_key),
          email: row.email === null ? null : String(row.email),
          name: row.name === null ? null : String(row.name),
          role: String(row.role),
          createdAt: num(row.created_at),
        }
      }),
      kv: kvCounts.rows.map((r) => {
        const row = r as Record<string, unknown>
        return { owner: String(row.owner), collection: String(row.collection), live: num(row.n) }
      }),
      blobs: blobCounts.rows.map((r) => {
        const row = r as Record<string, unknown>
        return { owner: String(row.owner), status: String(row.status), count: num(row.n), bytes: num(row.bytes) }
      }),
    })
  },
})

interface PurgeBody {
  dryRun?: boolean
  accounts?: string[]
  kv?: Array<{ owner?: string; collection: string; key: string }>
  blobs?: string[]
}

export const POST = withV5Handler({
  operation: 'admin.purge.execute',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    if (ctx.user!.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Purge control requires an admin/master key.', 403)
    }
    const body = (await req.json().catch(() => ({}))) as PurgeBody
    const dryRun = body.dryRun === true
    const db = await v5db()

    // ── Resolve accounts (explicit ids or emails — never patterns) ──────────
    const accountIds: string[] = []
    const unresolvedAccounts: string[] = []
    for (const ident of body.accounts ?? []) {
      if (typeof ident !== 'string' || !ident) continue
      const rs = await db.execute({
        sql: `SELECT DISTINCT owner_key FROM v5_accounts WHERE id = ? OR email_lower = ? LIMIT 2`,
        args: [ident, ident.toLowerCase()],
      })
      const ids = rs.rows.map((r) => String((r as Record<string, unknown>).owner_key))
      if (ids.length === 0 || ids.includes('master') || ids.includes('admin')) {
        // Never allow purging the seeded service accounts.
        unresolvedAccounts.push(ident)
        continue
      }
      accountIds.push(...ids)
    }

    // ── Resolve blobs (explicit ids) ────────────────────────────────────────
    const blobRows: Array<{ id: string; owner: string; mode: 'parts' | 'single' }> = []
    const unresolvedBlobs: string[] = []
    for (const id of body.blobs ?? []) {
      if (typeof id !== 'string' || !/^blb_[a-z0-9]+$/.test(id)) {
        unresolvedBlobs.push(id)
        continue
      }
      const row = await getBlob(id)
      if (!row) {
        unresolvedBlobs.push(id)
        continue
      }
      blobRows.push({ id, owner: row.owner, mode: row.storageKey === 'parts' ? 'parts' : 'single' })
    }

    // ── Resolve explicit kv entries ─────────────────────────────────────────
    const kvEntries = (body.kv ?? []).filter(
      (e): e is { owner: string; collection: string; key: string } =>
        !!e && typeof e.collection === 'string' && typeof e.key === 'string' && e.collection.length > 0,
    )

    if (dryRun) {
      return ctx.ok({
        dryRun: true,
        wouldDelete: {
          accounts: accountIds,
          unresolvedAccounts,
          kv: kvEntries,
          blobs: blobRows,
          unresolvedBlobs,
        },
      })
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    let kvDeleted = 0
    let blobsDeleted = 0
    let telegramDocsDeleted = 0
    const errors: string[] = []

    // 1. Explicit KV deletes (delta channel propagates each tombstone).
    for (const e of kvEntries) {
      try {
        if (await kvDelete(e.owner, e.key, e.collection)) kvDeleted++
      } catch (err) {
        errors.push(`kv ${e.collection}/${e.key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 2. Blob deletes (Telegram docs + manifests + part records + tombstones).
    for (const b of blobRows) {
      try {
        if (b.mode === 'parts') {
          const r = await deletePartsBlob(b.owner, b.id)
          blobsDeleted++
          telegramDocsDeleted += r.deletedDocs
        } else {
          await deleteBlob(b.id, b.owner)
          blobsDeleted++
        }
      } catch (err) {
        errors.push(`blob ${b.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 3. Account purge: all their KV rows, all their blobs, then the rows.
    for (const accountId of accountIds) {
      try {
        // Their blobs (any status).
        const rs = await db.execute({
          sql: `SELECT id, storage_key FROM v5_blobs WHERE owner = ? AND status != 'deleted' LIMIT 500`,
          args: [accountId],
        })
        for (const r of rs.rows) {
          const row = r as Record<string, unknown>
          const id = String(row.id)
          try {
            if (String(row.storage_key) === 'parts') {
              const res = await deletePartsBlob(accountId, id)
              telegramDocsDeleted += res.deletedDocs
            } else {
              await deleteBlob(id, accountId)
            }
            blobsDeleted++
          } catch (err) {
            errors.push(`blob ${id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        // Their KV rows (soft-delete en masse; blobmeta keys go to the
        // metaDel ring so the blobs channel propagates them too).
        const kvrs = await db.execute({
          sql: `SELECT collection, key FROM v5_kv WHERE owner = ? AND deleted_at IS NULL LIMIT 5000`,
          args: [accountId],
        })
        const now = nowMs()
        if (kvrs.rows.length > 0) {
          await db.execute({
            sql: `UPDATE v5_kv SET deleted_at = ?, updated_at = ? WHERE owner = ? AND deleted_at IS NULL`,
            args: [now, now, accountId],
          })
          kvDeleted += kvrs.rows.length
          for (const r of kvrs.rows) {
            const row = r as Record<string, unknown>
            if (String(row.collection) === 'v5_blobmeta') noteBlobMetaDelete(accountId, String(row.key))
          }
        }
        // The account rows themselves + the purge tombstone for snapshots.
        await db.execute({ sql: `DELETE FROM v5_accounts WHERE id = ? OR owner_key = ?`, args: [accountId, accountId] })
        noteAccountDelete(accountId)
      } catch (err) {
        errors.push(`account ${accountId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 4. Push convergence: kv delta (KV tombstones), blobs snapshot (blob
    //    tombstones + metaDel), full snapshot (accountsDel).
    try {
      const { durable } = await import('@/lib/v5/durable')
      const { uploadKvDelta, uploadBlobsSnapshot, uploadV5Snapshot } = await import('@/lib/v5/backup')
      durable(
        (async () => {
          await uploadKvDelta('manual').catch(() => undefined)
          await uploadBlobsSnapshot('finalize').catch(() => undefined)
          await uploadV5Snapshot('manual').catch(() => undefined)
        })().catch(() => undefined),
      )
    } catch {
      /* convergence rides the next scheduled snapshot regardless */
    }

    return ctx.ok({
      dryRun: false,
      deleted: {
        accounts: accountIds.length,
        kvKeys: kvDeleted,
        blobs: blobsDeleted,
        telegramDocs: telegramDocsDeleted,
      },
      unresolvedAccounts,
      unresolvedBlobs,
      errors: errors.slice(0, 50),
    })
  },
})
