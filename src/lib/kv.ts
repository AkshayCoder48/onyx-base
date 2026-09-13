/**
 * Onyx Base — core key-value operations shared by the REST API (v1) and the
 * dashboard API.
 *
 * Storage: in-memory store + JSON cache + Telegram mirror (see store.ts).
 * No Prisma, no SQLite. Telegram is the durable backup; the JSON cache
 * (`db/cloudkv.json`) mirrors it so the index survives restarts.
 */

import {
  coerceValue,
  detectValueType,
  type AuthenticatedUser,
} from '@/lib/auth'
import {
  upsertRecord,
  findRecord,
  deleteRecord,
  listRecords,
  addLog,
  resolveChatId,
  resolveBotToken,
  resolveBotApiBaseUrl,
  maybeRehydrateAccount,
  flushAccountSync,
  offloadLargeRecordValue,
} from '@/lib/data-store'
import { downloadJsonDocument } from '@/lib/telegram'
import { notifyRealtime } from '@/lib/realtime'

export interface SetOptions {
  /** The record key (required for set/touch operations). */
  key?: string
  collection?: string
  source?: string
  /** Raw string value; will be coerced. Mutually exclusive with `json`. */
  raw?: string
  /** Already-typed JSON value. */
  json?: unknown
}

export interface RecordView {
  key: string
  value: unknown
  valueType: string
  collection: string
  updatedAt: string
  createdAt: string
  /** True when the write was confirmed in the durable Telegram mirror before
   * responding. Only set on setKey results. */
  durable?: boolean
}

function toView(r: {
  key: string
  value: string
  valueType: string
  collection: string
  updatedAt: string
  createdAt: string
  valueRef?: { fileId: string; messageId: number; bytes: number } | null
}): RecordView {
  // Large-value refs resolve only on single-key GET (getKey). List/export
  // show a placeholder — resolving N multi-MB documents per listing would
  // be ruinous, and no list consumer needs inline chunk bytes.
  if (r.valueRef?.fileId) {
    return {
      key: r.key,
      value: `[large value — ${r.valueRef.bytes} bytes, fetch via GET]`,
      valueType: r.valueType,
      collection: r.collection,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
    }
  }
  let parsed: unknown = r.value
  try {
    parsed = JSON.parse(r.value)
  } catch {
    /* keep raw */
  }
  return {
    key: r.key,
    value: parsed,
    valueType: r.valueType,
    collection: r.collection,
    updatedAt: r.updatedAt,
    createdAt: r.createdAt,
  }
}

/**
 * Set (upsert) a key. DURABLE before responding: large values are offloaded
 * to their own Telegram document, then the merged account manifest is
 * pinned — only then do we answer. This is what makes writes survive
 * serverless instance recycling (the old fire-and-forget sync evaporated).
 * Returns the resulting record view (+ `durable` flag).
 */
export async function setKey(
  user: AuthenticatedUser,
  opts: SetOptions,
): Promise<RecordView> {
  const collectionName = opts.collection || 'default'

  let value: unknown
  let valueType: string
  if (opts.json !== undefined) {
    value = opts.json
    valueType = detectValueType(value)
  } else {
    const coerced = coerceValue(opts.raw ?? '')
    value = coerced.value
    valueType = coerced.type
  }
  const serialized = JSON.stringify(value)

  // Resolve the user's custom Telegram chat ID + bot token + Bot API URL (falls back to env defaults).
  const chatId = resolveChatId(user.dbUserId)
  const botToken = resolveBotToken(user.dbUserId)
  const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)

  const { record } = upsertRecord(user.dbUserId, user.userId, {
    collection: collectionName,
    key: opts.key ?? '',
    value: serialized,
    valueType,
    chatId,
    botToken,
    botApiBaseUrl,
  })

  // Durability gate: offload large values, then await the merged manifest
  // sync. On failure we still answer ok (the value IS readable from this
  // instance and the debounced scheduler retries the sync) but flag it.
  // Hard 55s deadline over the WHOLE gate (offload + sync): offload sits
  // outside the sync deadline and the two could stack past the client's
  // 60s timeout (orphaned work may still land the pin — bonus, the
  // client's idempotent retry is the real backstop).
  let durable = false
  try {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[kv] durability gate deadline (55s) exceeded for ${collectionName}/${record.key}`)
        resolve(false)
      }, 55000)
    })
    const gate = (async () => {
      await offloadLargeRecordValue(user.dbUserId, collectionName, record.key, chatId, botToken, botApiBaseUrl)
      return await flushAccountSync(user.userId)
    })()
    durable = await Promise.race([gate, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
      // Swallow late rejections from the orphaned gate (it may still fail
      // after we answered — must never surface as unhandled).
      gate.catch(() => {})
    })
  } catch (err) {
    console.error(`[kv] durable sync failed for ${collectionName}/${record.key}:`, err)
  }

  await logAction(user, 'set', record.key, `collection=${collectionName}`, opts.source)
  notifyRealtime({ userId: user.userId, event: 'set', collection: collectionName, key: record.key })
  // Echo the ORIGINAL value (the stored record may now hold only a
  // large-value ref + '' — toView(record) would return a placeholder).
  return {
    key: record.key,
    value,
    valueType,
    collection: record.collection,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    durable,
  }
}

/** Get a single key (or null). Large-value refs are resolved transparently. */
export async function getKey(
  user: AuthenticatedUser,
  key: string,
  collection = 'default',
): Promise<RecordView | null> {
  const rec = findRecord(user.dbUserId, collection, key)
  if (!rec) return null
  await logAction(user, 'get', key, `collection=${collection}`, 'api')
  if (rec.valueRef?.fileId) {
    try {
      const botToken = resolveBotToken(user.dbUserId)
      const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)
      const text = await downloadJsonDocument(rec.valueRef.fileId, botToken, botApiBaseUrl)
      if (text === null) {
        console.error(`[kv] large-value ref unreadable for ${collection}/${key}`)
        return null
      }
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        /* keep raw */
      }
      return {
        key: rec.key,
        value: parsed,
        valueType: rec.valueType,
        collection: rec.collection,
        updatedAt: rec.updatedAt,
        createdAt: rec.createdAt,
      }
    } catch (err) {
      console.error(`[kv] large-value ref resolution failed for ${collection}/${key}:`, err)
      return null
    }
  }
  return toView(rec)
}

/**
 * Get a single key with read-your-writes recovery across serverless
 * instances. On a LOCAL miss, the record may simply live on another instance
 * (or in a newer Telegram manifest snapshot than the one this instance
 * hydrated). Pull the account's latest manifest (rate-guarded) and retry the
 * lookup once before answering 404 — this is what the docs describe as the
 * "lazily, on read" rehydrate, and fixes clients seeing spurious 404s for
 * records they just wrote (e.g. OnyxAgent workspace-sync chunk reads).
 */
export async function getKeyWithRehydrate(
  user: AuthenticatedUser,
  key: string,
  collection = 'default',
): Promise<RecordView | null> {
  let rec = await getKey(user, key, collection)
  if (rec) return rec
  const rehydrated = await maybeRehydrateAccount(user.userId)
  if (!rehydrated) return null
  rec = await getKey(user, key, collection)
  return rec
}

/**
 * Delete a key. Returns whether a record was removed.
 * Rehydrate-first: on a local miss the record may still exist durably
 * (this cold instance simply hasn't hydrated it yet) — pull the latest
 * manifest and retry before answering "not found", so deletes don't 404
 * spuriously. The merged manifest sync is awaited, so a returned delete
 * is durable (plus a tombstone stops resurrection).
 */
export async function deleteKey(
  user: AuthenticatedUser,
  key: string,
  collection = 'default',
  source = 'api',
): Promise<boolean> {
  const chatId = resolveChatId(user.dbUserId)
  const botToken = resolveBotToken(user.dbUserId)
  const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)
  let removed = deleteRecord(user.dbUserId, collection, key, chatId, botToken, botApiBaseUrl)
  if (!removed) {
    const rehydrated = await maybeRehydrateAccount(user.userId)
    if (rehydrated) {
      removed = deleteRecord(user.dbUserId, collection, key, chatId, botToken, botApiBaseUrl)
    }
    if (!removed) return false
  }
  try {
    const durable = await flushAccountSync(user.userId)
    if (!durable) console.error(`[kv] delete sync unconfirmed for ${collection}/${key}`)
  } catch (err) {
    console.error(`[kv] delete sync failed for ${collection}/${key}:`, err)
  }
  await logAction(user, 'delete', key, `collection=${collection}`, source)
  notifyRealtime({ userId: user.userId, event: 'delete', collection, key })
  return true
}

/** List all keys for a collection (or every collection when collection=undefined). */
export async function listKeys(
  user: AuthenticatedUser,
  collection?: string,
): Promise<RecordView[]> {
  const records = listRecords(user.dbUserId, collection)
  return records.map(toView)
}

/**
 * List keys with read-your-writes recovery + freshness. A non-empty local
 * view may still be STALE (another instance wrote since we hydrated), so we
 * always offer a refresh: maybeRehydrateAccount is rev-aware and
 * guard-throttled, costing ~1 getChat when fresh and a manifest download
 * only when the pinned rev actually advanced.
 */
export async function listKeysWithRehydrate(
  user: AuthenticatedUser,
  collection?: string,
): Promise<RecordView[]> {
  let records = await listKeys(user, collection)
  const rehydrated = await maybeRehydrateAccount(user.userId)
  if (!rehydrated) return records
  records = await listKeys(user, collection)
  return records
}

/**
 * Export every record (optionally scoped to a collection) as a JSON object.
 * Same always-refresh recovery as list, so instances never export stale
 * partial state while another instance holds newer writes.
 */
export async function exportData(
  user: AuthenticatedUser,
  collection?: string,
): Promise<Record<string, unknown>> {
  let records = await listKeys(user, collection)
  const rehydrated = await maybeRehydrateAccount(user.userId)
  if (rehydrated) records = await listKeys(user, collection)
  const out: Record<string, unknown> = {}
  for (const r of records) {
    const bucket = r.collection === 'default' ? '' : `${r.collection}.`
    out[`${bucket}${r.key}`] = r.value
  }
  return out
}

/** Write an audit log entry. */
export async function logAction(
  user: AuthenticatedUser,
  action: string,
  key?: string | null,
  detail?: string | null,
  source = 'api',
  ip?: string | null,
) {
  try {
    addLog({
      dbUserId: user.dbUserId,
      action,
      key,
      detail,
      source,
      ip,
    })
  } catch (err) {
    console.error('[log] failed to write log:', err)
  }
}
