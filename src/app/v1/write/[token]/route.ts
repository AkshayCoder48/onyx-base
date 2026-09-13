import { NextRequest } from 'next/server'
import { fail, ok, coerceValue, detectValueType } from '@/lib/auth'
import {
  resolveShareToken,
  findRecord,
  upsertRecord,
  addLog,
  resolveChatId,
  resolveBotToken,
  findUserByDbId,
} from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /v1/write/[token]
 *
 * PUBLIC, unauthenticated write endpoint for public HTML (public counters,
 * guestbooks, leaderboards, "I visited" buttons, etc.).
 *
 * The token is a scoped, revocable write token bound to ONE (collection, key).
 * Supports three ops (each must be in the token's allowedOps):
 *
 *   { "op": "set",     "value": "hello" }          — overwrite the value
 *   { "op": "incr",    "amount": 1 }                — numeric increment (clamped to incrMin/incrMax)
 *   { "op": "append",  "value": "line\n" }          — append to a string value
 *
 * Rate-limited per IP. Optionally time-limited (TTL). Optionally value-length
 * capped (maxValueLength) so a malicious visitor can't fill your Telegram
 * channel with megabytes of junk.
 *
 * The owner's master API key is NEVER exposed — the server performs the write
 * on the owner's behalf using their resolved Telegram config.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'

  // ── Parse body ──
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    return fail('Request body must be valid JSON.', 400)
  }

  const op = typeof body.op === 'string' ? body.op : 'set'
  if (op !== 'set' && op !== 'incr' && op !== 'append') {
    return fail('`op` must be one of: set, incr, append.', 400)
  }

  // ── Resolve + authorize the share token ──
  const resolved = resolveShareToken(token, ip, 'write')
  if (!resolved.ok) {
    return fail(resolved.reason, resolved.status)
  }
  const rec = resolved.record

  if (!rec.allowedOps.includes(op as 'set' | 'incr' | 'append')) {
    return fail(`This token does not allow the "${op}" operation.`, 403)
  }

  const collection = rec.collection
  const key = rec.key
  const ownerDbId = rec.userId
  const chatId = resolveChatId(ownerDbId)
  const botToken = resolveBotToken(ownerDbId)
  // Resolve the owner's public userId for the Telegram mirror payload.
  const owner = findUserByDbId(ownerDbId)
  const publicUserId = owner?.userId ?? 'shared'
  const existing = findRecord(ownerDbId, collection, key)

  // ── Handle each op ──
  if (op === 'set') {
    const rawValue = body.value
    if (rawValue === undefined) {
      return fail('`value` is required for the "set" op.', 400)
    }
    // Coerce: if it's already a JS value, use it; if it's a string, coerce.
    let value: unknown
    let valueType: string
    if (typeof rawValue === 'string') {
      const coerced = coerceValue(rawValue)
      value = coerced.value
      valueType = coerced.type
    } else {
      value = rawValue
      valueType = detectValueType(rawValue)
    }
    const serialized = JSON.stringify(value)
    if (rec.maxValueLength && serialized.length > rec.maxValueLength) {
      return fail(
        `Value too long (${serialized.length} bytes; max ${rec.maxValueLength}).`,
        413,
      )
    }
    const { record } = upsertRecord(ownerDbId, publicUserId, {
      collection,
      key,
      value: serialized,
      valueType,
      chatId,
      botToken,
    })
    try {
      addLog({
        dbUserId: ownerDbId,
        action: 'share_write',
        key,
        detail: `op=set collection=${collection} ip=${ip}`,
        source: 'share',
        ip,
      })
    } catch {
      /* best-effort */
    }
    return ok({ op: 'set', key: record.key, value, type: valueType, collection })
  }

  if (op === 'incr') {
    const amount = Number(body.amount ?? 1)
    if (!Number.isFinite(amount)) {
      return fail('`amount` must be a finite number for the "incr" op.', 400)
    }
    // Read current value (default 0 if missing or non-numeric).
    let current = 0
    if (existing) {
      try {
        const parsed = JSON.parse(existing.value)
        if (typeof parsed === 'number' && Number.isFinite(parsed)) current = parsed
      } catch {
        /* keep 0 */
      }
    }
    let next = current + amount
    // Clamp to configured bounds.
    if (rec.incrMin !== null && next < rec.incrMin) next = rec.incrMin
    if (rec.incrMax !== null && next > rec.incrMax) next = rec.incrMax
    const serialized = JSON.stringify(next)
    const { record } = upsertRecord(ownerDbId, publicUserId, {
      collection,
      key,
      value: serialized,
      valueType: 'number',
      chatId,
      botToken,
    })
    try {
      addLog({
        dbUserId: ownerDbId,
        action: 'share_write',
        key,
        detail: `op=incr amount=${amount} → ${next} ip=${ip}`,
        source: 'share',
        ip,
      })
    } catch {
      /* best-effort */
    }
    return ok({ op: 'incr', key: record.key, value: next, previous: current, type: 'number', collection })
  }

  // op === 'append'
  const chunk = body.value
  if (chunk === undefined) {
    return fail('`value` is required for the "append" op.', 400)
  }
  const chunkStr = typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
  const currentStr = existing ? (() => {
    try {
      return JSON.parse(existing.value)
    } catch {
      return existing.value
    }
  })() : ''
  const baseStr = typeof currentStr === 'string' ? currentStr : JSON.stringify(currentStr)
  const nextStr = baseStr + chunkStr
  const serialized = JSON.stringify(nextStr)
  if (rec.maxValueLength && serialized.length > rec.maxValueLength) {
    return fail(
      `Resulting value too long (${serialized.length} bytes; max ${rec.maxValueLength}).`,
      413,
    )
  }
  const { record } = upsertRecord(ownerDbId, publicUserId, {
    collection,
    key,
    value: serialized,
    valueType: 'string',
    chatId,
    botToken,
  })
  try {
    addLog({
      dbUserId: ownerDbId,
      action: 'share_write',
      key,
      detail: `op=append +${chunkStr.length}b ip=${ip}`,
      source: 'share',
      ip,
    })
  } catch {
    /* best-effort */
  }
  return ok({ op: 'append', key: record.key, value: nextStr, type: 'string', collection })
}
