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
} from '@/lib/data-store'
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
}

function toView(r: {
  key: string
  value: string
  valueType: string
  collection: string
  updatedAt: string
  createdAt: string
}): RecordView {
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

/** Set (upsert) a key. Returns the resulting record view. */
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

  await logAction(user, 'set', record.key, `collection=${collectionName}`, opts.source)
  notifyRealtime({ userId: user.userId, event: 'set', collection: collectionName, key: record.key })
  return toView(record)
}

/** Get a single key (or null). */
export async function getKey(
  user: AuthenticatedUser,
  key: string,
  collection = 'default',
): Promise<RecordView | null> {
  const rec = findRecord(user.dbUserId, collection, key)
  if (!rec) return null
  await logAction(user, 'get', key, `collection=${collection}`, 'api')
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

/** Delete a key. Returns whether a record was removed. */
export async function deleteKey(
  user: AuthenticatedUser,
  key: string,
  collection = 'default',
  source = 'api',
): Promise<boolean> {
  const chatId = resolveChatId(user.dbUserId)
  const botToken = resolveBotToken(user.dbUserId)
  const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)
  const removed = deleteRecord(user.dbUserId, collection, key, chatId, botToken, botApiBaseUrl)
  if (!removed) return false
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
 * List keys with read-your-writes recovery. A cold instance with an empty
 * (locally) view of the collection may simply not have hydrated the account
 * yet — pull the latest manifest (rate-guarded) and re-list. Only rehydrates
 * when the local result is EMPTY, so repeated listing of a populated
 * collection never touches Telegram.
 */
export async function listKeysWithRehydrate(
  user: AuthenticatedUser,
  collection?: string,
): Promise<RecordView[]> {
  let records = await listKeys(user, collection)
  if (records.length > 0) return records
  const rehydrated = await maybeRehydrateAccount(user.userId)
  if (!rehydrated) return records
  records = await listKeys(user, collection)
  return records
}

/** Export every record (optionally scoped to a collection) as a JSON object. */
export async function exportData(
  user: AuthenticatedUser,
  collection?: string,
): Promise<Record<string, unknown>> {
  const records = await listKeys(user, collection)
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
