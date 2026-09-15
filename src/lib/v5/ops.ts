/**
 * OnyxBase V5 — operations & idempotency (docs/v5-contract.md §9-10).
 *
 * Durable operation records in SQLite — they survive instance restarts and
 * cold boots (unlike in-memory stores). This is what lets a client that
 * LOST a response discover the authoritative outcome afterward.
 */

import { randomUUID } from 'node:crypto'
import { v5db, nowMs, num } from './db'

export type OpStatus = 'processing' | 'completed' | 'failed'

export interface V5Op {
  id: string
  owner: string
  type: string
  idemKey: string | null
  status: OpStatus
  request: unknown
  result: unknown
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  durationMs: number | null
}

export class OpConflictError extends Error {
  constructor(public readonly existing: V5Op) {
    super('An operation with this idempotency key is already in progress.')
    this.name = 'OpConflictError'
  }
}

function rowToOp(row: Record<string, unknown>): V5Op {
  const parse = (s: unknown): unknown => {
    try {
      return JSON.parse(String(s))
    } catch {
      return null
    }
  }
  return {
    id: String(row.id),
    owner: String(row.owner),
    type: String(row.type),
    idemKey: (row.idem_key as string) ?? null,
    status: String(row.status) as OpStatus,
    request: parse(row.request_json),
    result: parse(row.result_json),
    errorCode: (row.error_code as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
  }
}

/**
 * Begin an operation. When idemKey collides with an existing op:
 *  - completed/failed → returns the existing (caller replays/inspects it)
 *  - processing       → throws OpConflictError (HTTP 409 retryable)
 */
export async function beginOp(
  owner: string,
  type: string,
  request: unknown,
  idemKey?: string | null
): Promise<{ op: V5Op; existed: boolean }> {
  const db = await v5db()
  const now = nowMs()
  if (idemKey) {
    const rs = await db.execute({
      sql: `SELECT * FROM v5_ops WHERE owner = ? AND type = ? AND idem_key = ? LIMIT 1`,
      args: [owner, type, idemKey],
    })
    if (rs.rows.length > 0) {
      const existing = rowToOp(rs.rows[0] as Record<string, unknown>)
      if (existing.status === 'processing') throw new OpConflictError(existing)
      return { op: existing, existed: true }
    }
  }
  const id = randomUUID()
  try {
    await db.execute({
      sql: `INSERT INTO v5_ops (id, owner, type, idem_key, status, request_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
      args: [id, owner, type, idemKey ?? null, JSON.stringify(request ?? null), now, now],
    })
  } catch (err) {
    // Unique-index race: another request inserted the same idem key first.
    if (idemKey && /unique|constraint/i.test(String(err))) {
      const rs = await db.execute({
        sql: `SELECT * FROM v5_ops WHERE owner = ? AND type = ? AND idem_key = ? LIMIT 1`,
        args: [owner, type, idemKey],
      })
      if (rs.rows.length > 0) {
        const existing = rowToOp(rs.rows[0] as Record<string, unknown>)
        if (existing.status === 'processing') throw new OpConflictError(existing)
        return { op: existing, existed: true }
      }
    }
    throw err
  }
  return {
    op: { id, owner, type, idemKey: idemKey ?? null, status: 'processing', request, result: null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, durationMs: null },
    existed: false,
  }
}

export async function completeOp(opId: string, result: unknown): Promise<void> {
  const db = await v5db()
  const now = nowMs()
  await db.execute({
    sql: `UPDATE v5_ops SET status = 'completed', result_json = ?, updated_at = ?, duration_ms = ? - created_at WHERE id = ?`,
    args: [JSON.stringify(result ?? null), now, now, opId],
  })
}

export async function failOp(opId: string, code: string, message: string): Promise<void> {
  const db = await v5db()
  const now = nowMs()
  await db.execute({
    sql: `UPDATE v5_ops SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?, duration_ms = ? - created_at WHERE id = ?`,
    args: [code, message, now, now, opId],
  })
}

export async function getOp(id: string): Promise<V5Op | null> {
  const db = await v5db()
  const rs = await db.execute({ sql: `SELECT * FROM v5_ops WHERE id = ? LIMIT 1`, args: [id] })
  return rs.rows.length > 0 ? rowToOp(rs.rows[0] as Record<string, unknown>) : null
}

export async function lookupOp(owner: string, type: string, idemKey: string): Promise<V5Op | null> {
  const db = await v5db()
  const rs = await db.execute({
    sql: `SELECT * FROM v5_ops WHERE owner = ? AND type = ? AND idem_key = ? LIMIT 1`,
    args: [owner, type, idemKey],
  })
  return rs.rows.length > 0 ? rowToOp(rs.rows[0] as Record<string, unknown>) : null
}
