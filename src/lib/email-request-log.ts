/**
 * Onyx Base — Email Automation request log (PRD §22, §34).
 *
 * Every email request gets a `req_…` ID. We track ONLY non-sensitive
 * metadata — NEVER the email body, recipient, OTP, credential material or
 * authorization headers:
 *
 *   { requestId, ts, endpoint, credential, status, latencyMs,
 *     upstreamStatus?, errorCode? }
 *
 * Two layers:
 *   1. In-memory ring buffer (fast, current instance).
 *   2. A persisted record `__email_log__ / recent` capped at the last
 *      MAX_PERSISTED sends per user — rides the normal cloudkv + Telegram
 *      mirror pipeline, so request status is eventually visible across
 *      serverless instances (a cold instance answers from this snapshot).
 *
 * Retention: entries older than RETENTION_MS (7 days) are dropped on write.
 * The requestId is the debugging handle — operators grep logs by ID instead
 * of ever logging sensitive request content.
 */

import { upsertRecord, findRecord } from '@/lib/data-store'

const COLLECTION = '__email_log__'
const KEY = 'recent'

/** In-memory: max entries per user. */
const MEMORY_CAP = 200
/** Persisted: max entries written to the user's store. */
export const MAX_PERSISTED = 50
/** 7 days. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type EmailRequestStatus = 'sent' | 'failed'

export interface EmailLogEntry {
  requestId: string
  ts: string
  endpoint: string
  /** Credential NAME only — never the key. */
  credential: string
  status: EmailRequestStatus
  latencyMs: number
  /** MCPEmails HTTP status when the upstream was reached. */
  upstreamStatus?: number
  /** Machine error code (e.g. missing_variable) — never a raw message. */
  errorCode?: string
}

const memory = new Map<string, EmailLogEntry[]>()

function prune(entries: EmailLogEntry[]): EmailLogEntry[] {
  const cutoff = Date.now() - RETENTION_MS
  return entries.filter((e) => Date.parse(e.ts) >= cutoff)
}

/** Record an entry (in-memory + persisted snapshot). Fire-and-forget safe. */
export function recordEmailRequest(
  dbUserId: string,
  publicUserId: string,
  entry: EmailLogEntry,
): void {
  // 1. Memory ring buffer.
  const arr = prune(memory.get(dbUserId) ?? [])
  arr.unshift(entry)
  if (arr.length > MEMORY_CAP) arr.length = MEMORY_CAP
  memory.set(dbUserId, arr)

  // 2. Persisted snapshot (last MAX_PERSISTED entries, oldest first for
  //    readability). Merging with the previous snapshot keeps entries that
  //    were created on a different instance.
  const persisted = readPersisted(dbUserId)
  const merged: EmailLogEntry[] = []
  const seen = new Set<string>()
  for (const e of [entry, ...arr, ...persisted]) {
    if (seen.has(e.requestId)) continue
    seen.add(e.requestId)
    merged.push(e)
    if (merged.length >= MAX_PERSISTED) break
  }
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: KEY,
    value: JSON.stringify(merged.slice(0, MAX_PERSISTED)),
    valueType: 'array',
  })
}

function readPersisted(dbUserId: string): EmailLogEntry[] {
  const rec = findRecord(dbUserId, COLLECTION, KEY)
  if (!rec) return []
  try {
    const parsed = JSON.parse(rec.value) as EmailLogEntry[]
    if (!Array.isArray(parsed)) return []
    return prune(parsed.filter((e) => e && typeof e.requestId === 'string'))
  } catch {
    return []
  }
}

/** Recent entries for a user: current instance memory first, then persisted. */
export function listEmailRequests(dbUserId: string): EmailLogEntry[] {
  const mem = prune(memory.get(dbUserId) ?? [])
  const persisted = readPersisted(dbUserId)
  const merged: EmailLogEntry[] = []
  const seen = new Set<string>()
  for (const e of [...mem, ...persisted]) {
    if (seen.has(e.requestId)) continue
    seen.add(e.requestId)
    merged.push(e)
  }
  return merged.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, MEMORY_CAP)
}

/** Look up a single request by ID (memory → persisted). */
export function findEmailRequest(dbUserId: string, requestId: string): EmailLogEntry | null {
  const mem = memory.get(dbUserId)?.find((e) => e.requestId === requestId)
  if (mem) return mem
  const persisted = readPersisted(dbUserId).find((e) => e.requestId === requestId)
  return persisted ?? null
}
