/**
 * OnyxBase V5 — ASYNC Telegram backup mirror (fire-and-forget).
 *
 * V5's authority is the SQLite store (local file or remote libsql/Turso).
 * Telegram is a BELT-AND-SUSPENDERS backup mirror only:
 *
 *   - Jobs are queued from the request path but NEVER awaited there — a
 *     commit response only ever waits for the local SQLite commit.
 *   - When V5_DATABASE_URL is a remote libsql:// URL the SQLite store is
 *     already remotely durable (Turso replication), so this mirror is
 *     redundancy on top of redundancy. Operators can disable it with
 *     V5_TELEGRAM_BACKUP=false.
 *   - The queue lives in module scope (globalThis) with bounded size,
 *     ~1 job/s pacing (Telegram same-chat limits), and bounded retries with
 *     exponential backoff. A dropped job logs an error — the SQLite data is
 *     unaffected.
 *
 * Mirrored payloads reuse the V4 telegram.ts primitives (sendKvMessage /
 * sendDocumentFile) so the backup chat stays human-readable and consistent
 * with V4's message format.
 */

import fs from 'fs'
import { isTelegramConfigured, sendDocumentFile, sendKvMessage, type TelegramPayload } from '@/lib/telegram'
import { isV5TelegramBackupEnabled } from './db'
import { noteMirroredBlobPart, noteMirroredWrite } from './backup'
import { durable } from './durable'

type MirrorJob =
  | { kind: 'kv'; payload: TelegramPayload; attempts: number; notBefore: number }
  | { kind: 'blob-part'; blobId: string; partPath: string; partName: string; attempts: number; notBefore: number }

interface MirrorState {
  jobs: MirrorJob[]
  running: boolean
  /** The active drain cycle (null when idle) — see armDrain. */
  drainPromise: Promise<void> | null
}

interface MirrorGlobal {
  __v5Mirror?: MirrorState
}

const MAX_QUEUE = 10_000 // bounded; each job is a tiny object
const PACE_MS = 1_100 // Telegram same-chat ~1 msg/s
const MAX_ATTEMPTS = 5

function mirrorState(): MirrorState {
  const g = globalThis as unknown as MirrorGlobal
  if (!g.__v5Mirror) g.__v5Mirror = { jobs: [], running: false, drainPromise: null }
  return g.__v5Mirror
}

/** Is the mirror active at all (env enabled + Telegram configured)? */
export function isV5MirrorActive(): boolean {
  return isV5TelegramBackupEnabled() && isTelegramConfigured()
}

function enqueue(job: MirrorJob): void {
  if (!isV5MirrorActive()) return
  const state = mirrorState()
  if (state.jobs.length >= MAX_QUEUE) {
    const dropped = state.jobs.shift()
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        operation: 'v5.mirror.drop',
        level: 'error',
        error: 'mirror queue full — dropping oldest job (SQLite remains authoritative)',
        droppedKind: dropped?.kind,
        blobId: dropped?.kind === 'blob-part' ? dropped.blobId : undefined,
      }),
    )
  }
  state.jobs.push(job)
  armDrain()
}

/**
 * Start (or attach to) the current drain cycle. Called SYNCHRONOUSLY from the
 * request path (enqueue ← kvSet/blobs/auth) so durable() registers the drain
 * on the live invocation — the platform keeps the function alive through the
 * paced Telegram sends AND the idle snapshot that follows (Vercel freeze
 * fix: fire-and-forget drains were killed the moment the response shipped).
 */
function armDrain(): void {
  const state = mirrorState()
  if (state.drainPromise) return
  const p = (async () => {
    try {
      await drain()
    } finally {
      state.drainPromise = null
      // Jobs that raced in while this cycle was closing: chain a fresh cycle
      // (same durable slot) so they are never left frozen in the queue.
      if (state.jobs.length > 0) armDrain()
    }
  })()
  state.drainPromise = p
  durable(p)
}

async function drain(): Promise<void> {
  const state = mirrorState()
  if (state.running) return
  state.running = true
  try {
    for (;;) {
      const now = Date.now()
      const job = state.jobs.find((j) => j.notBefore <= now)
      if (!job) break
      state.jobs.splice(state.jobs.indexOf(job), 1)
      const ok = await runJob(job)
      if (!ok) {
        job.attempts += 1
        if (job.attempts >= MAX_ATTEMPTS) {
          console.error(
            JSON.stringify({
              t: new Date().toISOString(),
              operation: 'v5.mirror.failed',
              level: 'error',
              error: `mirror job gave up after ${job.attempts} attempts (SQLite remains authoritative)`,
              kind: job.kind,
              blobId: job.kind === 'blob-part' ? job.blobId : undefined,
            }),
          )
        } else {
          // exponential-ish backoff: 5s, 20s, 45s, 80s
          const delayMs = 5_000 * job.attempts * job.attempts
          job.notBefore = Date.now() + delayMs
          state.jobs.push(job)
        }
      }
      // Pace to ~1 Telegram message per second.
      await sleep(PACE_MS)
    }
  } finally {
    state.running = false
    // Jobs may have arrived (or been re-queued) while we paced — armDrain's
    // finally re-arms a fresh cycle for them.
    if (state.jobs.length > 0) {
      return
    }
    // Queue idle → periodic full-state snapshot to Telegram (the "data saver"
    // role: the pinned snapshot makes cold boots + disaster recovery instant).
    // Runs INSIDE the durable drain promise, so the invocation stays alive
    // until the snapshot is pinned (or fails — best-effort either way).
    try {
      const { maybeSnapshotOnIdle } = await import('./backup')
      await maybeSnapshotOnIdle()
    } catch {
      /* snapshot optional */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runJob(job: MirrorJob): Promise<boolean> {
  try {
    if (job.kind === 'kv') {
      const messageId = await sendKvMessage(job.payload)
      if (messageId !== null) noteMirroredWrite()
      return messageId !== null
    }
    // blob-part: stream the staged part file (≤ 4 MiB) to Telegram as a
    // document named <blobId>.partNNNNNN — the backup chat mirrors the
    // staging layout 1:1 so a restore is a trivial concatenation.
    const buf = await fs.promises.readFile(job.partPath)
    const sent = await sendDocumentFile({
      file: new Blob([new Uint8Array(buf)]),
      fileName: job.partName,
      mimeType: 'application/octet-stream',
      caption: `onyxbase-v5-blob|${job.blobId}`,
    })
    if (sent.ok && sent.document) {
      // Record the Telegram reference so full-state snapshots can point at
      // the part for byte-level restore.
      noteMirroredBlobPart(job.blobId, {
        messageId: sent.document.messageId,
        fileId: sent.document.fileId,
        fileName: job.partName,
        bytes: buf.length,
      })
    }
    return sent.ok
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.mirror.error', level: 'warn', error: message, kind: job.kind }))
    return false
  }
}

// ─── Public enqueue API (call WITHOUT awaiting — fire-and-forget) ───────────

/** Queue a KV SET/DELETE backup message. Values ride the payload exactly as
 *  V4 mirrored them (the backup chat is private to the operator). */
export function queueKvMirror(payload: TelegramPayload): void {
  enqueue({ kind: 'kv', payload, attempts: 0, notBefore: 0 })
}

/** Queue one staged blob part file for the Telegram backup. */
export function queueBlobPartMirror(blobId: string, partPath: string, partName: string): void {
  enqueue({ kind: 'blob-part', blobId, partPath, partName, attempts: 0, notBefore: 0 })
}
