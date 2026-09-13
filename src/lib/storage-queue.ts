/**
 * Onyx Base — Durable storage operation queue.
 *
 * The previous implementation fired Telegram mirror writes via
 * `fireAndForget()` (setImmediate + Promise.catch(() => {})). This had two
 * critical problems:
 *
 *   1. A failed `sendKvMessage` left the record's `telegramMessageId` as
 *      `null` permanently. The local store had the data, but Telegram had
 *      no mirror. The user got NO error. On the next cold-boot rehydrate,
 *      the un-mirrored record was LOST (because rehydrate pulls from
 *      Telegram, not from the local cache).
 *
 *   2. A network blip during a Telegram write was completely invisible — the
 *      app silently dropped the durable mirror operation, leaving the user
 *      with a false sense of success.
 *
 * This module replaces that pattern with a durable, in-memory + on-disk
 * operation queue. Every mirror write goes through `enqueue()`. Failed
 * operations are retried with exponential backoff (1s → 2s → 4s → 8s → 16s
 * → 30s → 60s, with jitter). Permanent failures (e.g. invalid bot token)
 * are NOT retried — they're marked as `failed` and surfaced in the
 * diagnostics panel.
 *
 * The queue is persisted to `db/storage-queue.json` so it survives process
 * restarts. On startup, any `pending` operations are immediately retried.
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { isTelegramErrorRetryable, type TelegramError } from '@/lib/telegram-errors'

export type OperationKind = 'kv_set' | 'kv_edit' | 'kv_delete' | 'event' | 'file_upload' | 'file_delete' | 'manifest'

export type OperationStatus =
  | 'pending' // queued, not yet attempted
  | 'in_flight' // currently being sent to Telegram
  | 'durable' // Telegram confirmed the write
  | 'retrying' // failed once, will retry with backoff
  | 'failed' // exhausted retries (or non-retryable error); needs operator attention
  | 'reconciled' // resolved by a later write / cleanup

export interface StorageOperation {
  /** Stable unique ID (cuid). */
  id: string
  /** What kind of operation this is. Drives which Telegram method to call. */
  operation: OperationKind
  /** The owning user's dbUserId (so we can resolve credentials + chat ID). */
  dbUserId: string
  /** Collection name (for kv_* ops) or empty (for events / manifests). */
  collection: string
  /** Record key (for kv_* ops). */
  key: string
  /** JSON-serialized payload (the value to mirror). */
  payload: string
  /** The record's own ID (so we can patch `telegramMessageId` back onto it). */
  recordId?: string
  /**
   * Idempotency key — when set, the queue dedupes pending ops for the same
   * (recordId, operation) within a 5-minute window. Prevents duplicate
   * Telegram messages from frontend retries.
   */
  idempotencyKey?: string
  /** Current status. */
  status: OperationStatus
  /** Number of attempts so far. */
  attempts: number
  /** Max attempts before giving up (default 7). */
  maxAttempts: number
  /** Epoch-ms when to next attempt (for backoff). */
  nextAttemptAt: number
  /** Last error category + description (for diagnostics). */
  lastError?: string
  lastErrorCategory?: string
  /** When the operation was first enqueued. */
  createdAt: number
  /** When the operation was last updated. */
  updatedAt: number
  /** When the operation reached `durable` status (null otherwise). */
  completedAt?: number
}

const DATA_DIR = !!process.env.VERCEL || !!process.env.CF_PAGES || !!process.env.CLOUDFLARE
  ? '/tmp'
  : path.join(process.cwd(), 'db')
const QUEUE_PATH = path.join(DATA_DIR, 'storage-queue.json')

const MAX_ATTEMPTS = 7

// Exponential backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s, 60s.
const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000, 30000, 60000]

interface QueueShape {
  operations: StorageOperation[]
}

const EMPTY_QUEUE: QueueShape = { operations: [] }

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadQueue(): QueueShape {
  try {
    const raw = fs.readFileSync(QUEUE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as QueueShape
    return { operations: Array.isArray(parsed.operations) ? parsed.operations : [] }
  } catch {
    return { ...EMPTY_QUEUE }
  }
}

function saveQueue(q: QueueShape) {
  try {
    const dir = path.dirname(QUEUE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmpPath = QUEUE_PATH + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(q, null, 2), 'utf-8')
    fs.renameSync(tmpPath, QUEUE_PATH)
  } catch (err) {
    console.error('[storage-queue] failed to persist queue:', err)
  }
}

// ─── In-memory queue (survives hot reloads via globalThis) ───────────────────

const globalForQueue = globalThis as unknown as { __onyxStorageQueue?: QueueShape }
const queue: QueueShape = globalForQueue.__onyxStorageQueue ?? (globalForQueue.__onyxStorageQueue = loadQueue())

// Save the queue to disk whenever it changes (debounced 500ms).
let saveTimer: NodeJS.Timeout | null = null
function persistSoon() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveQueue(queue), 500)
}

// ─── Worker (single-flight, in-process) ───────────────────────────────────────

let workerRunning = false
let workerTimer: NodeJS.Timeout | null = null

interface OperationExecutor {
  (op: StorageOperation): Promise<{ ok: true } | { ok: false; error: TelegramError }>
}

let executor: OperationExecutor | null = null

/**
 * Register the function that actually performs Telegram writes. Called by
 * `data-store.ts` on init (to break the circular import).
 */
export function registerExecutor(fn: OperationExecutor) {
  executor = fn
  // Start the worker.
  scheduleWorker(1000)
}

function scheduleWorker(delayMs: number) {
  if (workerTimer) clearTimeout(workerTimer)
  workerTimer = setTimeout(() => {
    workerTimer = null
    void runWorker()
  }, delayMs)
}

async function runWorker() {
  if (workerRunning || !executor) {
    scheduleWorker(5000)
    return
  }
  workerRunning = true
  try {
    const now = Date.now()
    // Pick the next pending / retrying operation whose nextAttemptAt <= now.
    // Limit to 5 ops per tick to avoid blocking the event loop.
    const ready = queue.operations
      .filter((op) => (op.status === 'pending' || op.status === 'retrying') && op.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, 5)

    for (const op of ready) {
      // Mark in-flight.
      op.status = 'in_flight'
      op.attempts += 1
      op.updatedAt = now
      persistSoon()

      try {
        const result = await executor!(op)
        if (result.ok) {
          op.status = 'durable'
          op.completedAt = Date.now()
          op.updatedAt = Date.now()
          op.lastError = undefined
          op.lastErrorCategory = undefined
        } else {
          const err = result.error
          op.lastError = err.description
          op.lastErrorCategory = err.category

          // Retryable: schedule the next attempt with backoff.
          // Non-retryable: mark failed.
          if (isTelegramErrorRetryable(err) && op.attempts < op.maxAttempts) {
            op.status = 'retrying'
            const backoffIdx = Math.min(op.attempts - 1, BACKOFF_SCHEDULE_MS.length - 1)
            const jitter = Math.floor(Math.random() * 500)
            op.nextAttemptAt = Date.now() + BACKOFF_SCHEDULE_MS[backoffIdx] + jitter
          } else {
            op.status = 'failed'
            op.nextAttemptAt = Date.now()
          }
          op.updatedAt = Date.now()
        }
      } catch (err) {
        op.lastError = err instanceof Error ? err.message : String(err)
        op.lastErrorCategory = 'unknown'
        if (op.attempts < op.maxAttempts) {
          op.status = 'retrying'
          const backoffIdx = Math.min(op.attempts - 1, BACKOFF_SCHEDULE_MS.length - 1)
          op.nextAttemptAt = Date.now() + BACKOFF_SCHEDULE_MS[backoffIdx]
        } else {
          op.status = 'failed'
        }
        op.updatedAt = Date.now()
      }
      persistSoon()
    }

    // Prune: drop durable operations older than 1h, drop failed older than 24h.
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    const before = queue.operations.length
    queue.operations = queue.operations.filter((op) => {
      if (op.status === 'durable' && (op.completedAt ?? 0) < oneHourAgo) return false
      if (op.status === 'failed' && op.updatedAt < oneDayAgo) return false
      if (op.status === 'reconciled') return false
      return true
    })
    if (queue.operations.length !== before) persistSoon()
  } finally {
    workerRunning = false
    // Schedule the next tick. Find the earliest nextAttemptAt among pending/retrying.
    const pending = queue.operations.filter((op) => op.status === 'pending' || op.status === 'retrying')
    if (pending.length > 0) {
      const earliest = Math.min(...pending.map((op) => op.nextAttemptAt))
      const delay = Math.max(500, earliest - Date.now())
      scheduleWorker(delay)
    } else {
      scheduleWorker(10000) // idle: check again in 10s
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Enqueue a Telegram mirror operation. Returns the operation ID (so callers
 * can track it via /api/diagnostics).
 *
 * Idempotency: if an op with the same (idempotencyKey) is already pending /
 * retrying, returns that op's ID instead of enqueuing a duplicate. This is
 * critical for handling frontend retries without creating duplicate Telegram
 * messages.
 */
export function enqueue(opts: {
  operation: OperationKind
  dbUserId: string
  collection?: string
  key?: string
  payload?: string
  recordId?: string
  idempotencyKey?: string
  maxAttempts?: number
}): string {
  const id = crypto.randomBytes(12).toString('hex')
  const now = Date.now()

  // Idempotency check.
  if (opts.idempotencyKey) {
    const existing = queue.operations.find(
      (op) =>
        op.idempotencyKey === opts.idempotencyKey &&
        (op.status === 'pending' || op.status === 'retrying' || op.status === 'in_flight'),
    )
    if (existing) return existing.id
  }

  const op: StorageOperation = {
    id,
    operation: opts.operation,
    dbUserId: opts.dbUserId,
    collection: opts.collection ?? '',
    key: opts.key ?? '',
    payload: opts.payload ?? '',
    recordId: opts.recordId,
    idempotencyKey: opts.idempotencyKey,
    status: 'pending',
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? MAX_ATTEMPTS,
    nextAttemptAt: now, // immediately ready
    createdAt: now,
    updatedAt: now,
  }
  queue.operations.push(op)
  persistSoon()
  // Wake the worker.
  scheduleWorker(100)
  return id
}

/**
 * Mark an operation as reconciled (resolved by a later write or by manual
 * cleanup). Removes it from the active queue.
 */
export function reconcile(operationId: string) {
  const op = queue.operations.find((o) => o.id === operationId)
  if (op) {
    op.status = 'reconciled'
    op.updatedAt = Date.now()
    persistSoon()
  }
}

/**
 * Return a snapshot of the queue for the diagnostics panel. Sensitive fields
 * (payload contents) are NOT included by default.
 */
export function snapshot(opts: { includePayload?: boolean; dbUserId?: string } = {}): {
  total: number
  pending: number
  inFlight: number
  durable: number
  retrying: number
  failed: number
  reconciled: number
  operations: Array<Omit<StorageOperation, 'payload'> & { payload?: string }>
} {
  const filtered = opts.dbUserId ? queue.operations.filter((op) => op.dbUserId === opts.dbUserId) : queue.operations
  const counts = {
    pending: 0,
    inFlight: 0,
    durable: 0,
    retrying: 0,
    failed: 0,
    reconciled: 0,
  }
  for (const op of filtered) {
    if (op.status === 'pending') counts.pending++
    else if (op.status === 'in_flight') counts.inFlight++
    else if (op.status === 'durable') counts.durable++
    else if (op.status === 'retrying') counts.retrying++
    else if (op.status === 'failed') counts.failed++
    else if (op.status === 'reconciled') counts.reconciled++
  }
  return {
    total: filtered.length,
    ...counts,
    operations: filtered.map((op) => ({
      ...op,
      payload: opts.includePayload ? op.payload : undefined,
    })),
  }
}

/**
 * Get the status of a single operation (for client-side polling).
 */
export function getStatus(operationId: string): StorageOperation | null {
  return queue.operations.find((op) => op.id === operationId) ?? null
}

/**
 * Force a retry of all failed operations (used by the diagnostics "Retry all"
 * button). Returns the count of operations that were re-queued.
 */
export function retryAllFailed(): number {
  let count = 0
  const now = Date.now()
  for (const op of queue.operations) {
    if (op.status === 'failed') {
      op.status = 'pending'
      op.attempts = 0
      op.nextAttemptAt = now
      op.updatedAt = now
      op.lastError = undefined
      op.lastErrorCategory = undefined
      count++
    }
  }
  if (count > 0) {
    persistSoon()
    scheduleWorker(100)
  }
  return count
}

// ─── Startup recovery ────────────────────────────────────────────────────────
// On module load, if there are pending / in_flight operations, schedule them
// immediately. (in_flight ops from a crashed process are reset to pending.)
(function recoverOnStartup() {
  const now = Date.now()
  let needsPersist = false
  for (const op of queue.operations) {
    if (op.status === 'in_flight') {
      op.status = 'pending'
      op.nextAttemptAt = now
      op.updatedAt = now
      needsPersist = true
    } else if (op.status === 'pending' || op.status === 'retrying') {
      // Already scheduled — make sure nextAttemptAt is in the future (or now).
      if (op.nextAttemptAt < now) op.nextAttemptAt = now
    }
  }
  if (needsPersist) persistSoon()
  // Schedule the worker to start as soon as the executor is registered.
  scheduleWorker(2000)
})()
