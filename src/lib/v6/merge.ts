/**
 * Onyx Base — V6 Ultima pure manifest-merge utilities.
 *
 * Extracted verbatim from data-store.ts so the V6 chat engine
 * (src/lib/v6/chat.ts) can merge manifests WITHOUT importing the store
 * module (data-store imports the chat engine for sync routing — keeping
 * this direction one-way avoids a module cycle). Everything in here is
 * pure: no store access, no Telegram calls, no side effects.
 *
 * All record types are imported TYPE-ONLY from data-store (erased at
 * compile time — zero runtime dependency on the store module).
 */

import { SYSTEM_ACCOUNT_ID, type AccountManifest } from '@/lib/telegram'
import type {
  RecordTombstone,
  RecordEntry,
  LogEntry,
  FileRecord,
  ShareTokenRecord,
  CollectionNameRecord,
  TelegramConfigRecord,
  AdminKeyRecord,
  ApiKeyRecord,
  UserRecord,
} from '@/lib/data-store'

export function msOf(iso: string | null | undefined): number {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? t : 0
}

export function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return msOf(b) > msOf(a) ? b : a
}

export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

export function mergeTombstoneLists(
  a: RecordTombstone[],
  b: RecordTombstone[],
  tombstoneTtlMs: number,
): RecordTombstone[] {
  const cutoff = Date.now() - tombstoneTtlMs
  const map = new Map<string, RecordTombstone>()
  for (const t of [...a, ...b]) {
    if (!t || !t.userId || !t.key || (t.kind !== 'record' && t.kind !== 'file')) continue
    if (msOf(t.deletedAt) < cutoff) continue
    const k = `${t.userId}|${t.kind}|${t.collection || ''}|${t.key}`
    const prev = map.get(k)
    if (!prev || msOf(t.deletedAt) > msOf(prev.deletedAt)) map.set(k, { ...t })
  }
  return [...map.values()]
}

export function tombMap(tombs: RecordTombstone[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tombs) {
    m.set(`${t.userId}|${t.kind}|${t.collection || ''}|${t.key}`, msOf(t.deletedAt))
  }
  return m
}

/**
 * Merge two account manifests (LOCAL ∪ REMOTE) into one converged manifest.
 * - records/files: latest-updatedAt-wins per identity, tombstone-shadowed
 *   items dropped.
 * - tombstones: union, latest-deletedAt-wins, TTL-pruned.
 * - logs: union by id (append-only).
 * - apiKeys/shareTokens/adminKeys: union by id; revoked=OR (a revoke anywhere
 *   sticks everywhere); lastUsedAt=max; other fields prefer the later of
 *   remote-then-local iteration (local wins on ties).
 * - user: latest-updatedAt-wins, passwordHash backfilled from either side.
 * - collectionNames/telegramConfigs: union by identity.
 * - adminKeys: only carried on the __system__ account.
 */
export function mergeAccountManifests(
  local: AccountManifest,
  remote: AccountManifest,
  tombstoneTtlMs: number,
): AccountManifest {
  const tombs = mergeTombstoneLists(
    asArray<RecordTombstone>(local.tombstones),
    asArray<RecordTombstone>(remote.tombstones),
    tombstoneTtlMs,
  )
  const tombById = tombMap(tombs)
  const shadowed = (
    userId: string,
    kind: 'record' | 'file',
    collection: string,
    key: string,
    updatedAt: string,
  ): boolean => {
    const del = tombById.get(`${userId}|${kind}|${collection || ''}|${key}`)
    return del !== undefined && msOf(updatedAt) < del
  }

  // Records: latest-updatedAt-wins per identity (local wins ties).
  const recMap = new Map<string, RecordEntry>()
  for (const r of asArray<RecordEntry>(remote.records)) {
    if (!r || !r.userId || !r.collection || !r.key) continue
    const k = `${r.userId}|${r.collection}|${r.key}`
    if (!recMap.has(k)) recMap.set(k, { ...r })
  }
  for (const r of asArray<RecordEntry>(local.records)) {
    if (!r || !r.userId || !r.collection || !r.key) continue
    const k = `${r.userId}|${r.collection}|${r.key}`
    const prev = recMap.get(k)
    if (!prev || msOf(r.updatedAt) >= msOf(prev.updatedAt)) recMap.set(k, { ...r })
  }
  const records = [...recMap.values()].filter(
    (r) => !shadowed(r.userId, 'record', r.collection, r.key, r.updatedAt),
  )

  // Files: same latest-wins + tombstone shadowing (tomb key = file id).
  const fileMap = new Map<string, FileRecord>()
  for (const f of [...asArray<FileRecord>(remote.files), ...asArray<FileRecord>(local.files)]) {
    if (!f || !f.id) continue
    const prev = fileMap.get(f.id)
    if (!prev || msOf(f.updatedAt) >= msOf(prev.updatedAt)) fileMap.set(f.id, { ...f })
  }
  const files = [...fileMap.values()].filter(
    (f) => !shadowed(f.userId, 'file', '', f.id, f.updatedAt),
  )

  // API keys: union + revoked-OR + lastUsedAt-max.
  const keyMap = new Map<string, ApiKeyRecord>()
  for (const k of [...asArray<ApiKeyRecord>(remote.apiKeys), ...asArray<ApiKeyRecord>(local.apiKeys)]) {
    if (!k || !k.id || !k.key || !k.userId) continue
    const prev = keyMap.get(k.id)
    if (!prev) {
      keyMap.set(k.id, { ...k })
    } else {
      keyMap.set(k.id, {
        ...prev,
        ...k,
        revoked: prev.revoked || k.revoked,
        lastUsedAt: maxIso(prev.lastUsedAt, k.lastUsedAt),
      })
    }
  }

  // Share tokens: same revoked-OR treatment.
  const shareMap = new Map<string, ShareTokenRecord>()
  for (const t of [...asArray<ShareTokenRecord>(remote.shareTokens), ...asArray<ShareTokenRecord>(local.shareTokens)]) {
    if (!t || !t.id) continue
    const prev = shareMap.get(t.id)
    if (!prev) {
      shareMap.set(t.id, { ...t })
    } else {
      shareMap.set(t.id, {
        ...prev,
        ...t,
        revoked: prev.revoked || t.revoked,
        lastUsedAt: maxIso(prev.lastUsedAt, t.lastUsedAt),
      })
    }
  }

  // Admin keys: union + revoked-OR.
  const adminMap = new Map<string, AdminKeyRecord>()
  for (const ak of [...asArray<AdminKeyRecord>(remote.adminKeys), ...asArray<AdminKeyRecord>(local.adminKeys)]) {
    if (!ak || !ak.key) continue
    const id = ak.id ?? ak.key
    const prev = adminMap.get(id)
    if (!prev) {
      adminMap.set(id, { ...ak })
    } else {
      adminMap.set(id, { ...prev, ...ak, revoked: prev.revoked || ak.revoked })
    }
  }

  // Logs: append-only union by id.
  const logMap = new Map<string, LogEntry>()
  for (const l of [...asArray<LogEntry>(remote.logs), ...asArray<LogEntry>(local.logs)]) {
    if (!l || !l.id) continue
    if (!logMap.has(l.id)) logMap.set(l.id, { ...l })
  }

  // Collection names: union by (userId, name).
  const cnMap = new Map<string, CollectionNameRecord>()
  for (const c of [...asArray<CollectionNameRecord>(remote.collectionNames), ...asArray<CollectionNameRecord>(local.collectionNames)]) {
    if (!c || !c.userId || !c.name) continue
    const k = `${c.userId}|${c.name}`
    if (!cnMap.has(k)) cnMap.set(k, { ...c })
  }

  // Telegram configs: union by userId (prefer local on conflict).
  const tcMap = new Map<string, TelegramConfigRecord>()
  for (const tc of [...asArray<TelegramConfigRecord>(remote.telegramConfigs), ...asArray<TelegramConfigRecord>(local.telegramConfigs)]) {
    if (!tc || !tc.userId) continue
    if (!tcMap.has(tc.userId)) tcMap.set(tc.userId, { ...tc })
    else if ((local.telegramConfigs as TelegramConfigRecord[]).some((x) => x.userId === tc.userId)) {
      tcMap.set(tc.userId, { ...(local.telegramConfigs as TelegramConfigRecord[]).find((x) => x.userId === tc.userId)! })
    }
  }

  // User: latest-updatedAt-wins + passwordHash backfill.
  const lu = (local.user ?? null) as UserRecord | null
  const ru = (remote.user ?? null) as UserRecord | null
  let user: unknown | null = lu ?? ru
  if (lu && ru) {
    const winner = msOf(ru.updatedAt) > msOf(lu.updatedAt) ? { ...ru } : { ...lu }
    if (!winner.passwordHash) winner.passwordHash = lu.passwordHash ?? ru.passwordHash ?? null
    user = winner
  }

  return {
    cloudkv: true,
    kind: 'account-manifest',
    version: 4,
    userId: local.userId,
    exportedAt: new Date().toISOString(),
    user,
    apiKeys: [...keyMap.values()],
    records,
    logs: [...logMap.values()],
    files,
    shareTokens: [...shareMap.values()],
    collectionNames: [...cnMap.values()],
    telegramConfigs: [...tcMap.values()],
    adminKeys:
      local.userId === SYSTEM_ACCOUNT_ID || remote.userId === SYSTEM_ACCOUNT_ID
        ? [...adminMap.values()]
        : [],
    tombstones: tombs,
  }
}
