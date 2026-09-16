/**
 * OnyxBase V5 — cross-instance freshness via Telegram snapshots (file mode).
 *
 * THE PROBLEM THIS MODULE SOLVES
 *   File-mode deployments (Vercel serverless, V5_DATABASE_URL=file:/tmp/v5.db)
 *   give EVERY instance its own ephemeral SQLite store. Boot-restore hydrates
 *   EMPTY stores only, so an instance that booted BEFORE another instance's
 *   writes would serve stale data forever:
 *
 *     register on instance A → login routed to instance B (booted earlier)
 *     → B never saw the account → "invalid credentials" — the exact
 *     commit-vs-response desync class V5 exists to eliminate.
 *
 * TELEGRAM IS THE CONVERGENCE POINT (the "data saver")
 *   The snapshot pointer (bot bio / pinned V4 index) is the shared watermark.
 *
 *   1. PROBE LOOP  — every 20s while an instance is warm, one cheap pointer
 *      read (getMyDescription). When the pointer ts is newer than the last
 *      snapshot this instance APPLIED, download + apply it. Upserts are
 *      updated_at-conditional, so newer local writes always win.
 *   2. MISS PROBES — auth lookups (login / register uniqueness / bearer
 *      resolution), kv reads and blob lookups that MISS locally trigger one
 *      rate-limited probe + retry, so cross-instance reads self-heal within
 *      seconds instead of waiting for the loop.
 *   3. AUTH SNAPSHOTS — account writes (register / login key mint) queue an
 *      immediate async snapshot (backup.queueAuthSnapshot), so the shared
 *      watermark advances within ~1-2s of a registration.
 *
 *   Remote mode (libsql://) shares ONE database across instances and never
 *   probes — everything here no-ops.
 */

import { isFileMode, isV5TelegramBackupEnabled } from './db'
import {
  getBioPointer,
  getIndexPointer,
  getLastAppliedSnapshotTs,
  restoreV5FromTelegram,
  type SnapshotPointer,
} from './backup'
import {
  applyBlobsSnapshot,
  applyKvDelta,
  getLastAppliedBlobsTs,
  getLastAppliedDeltaTs,
  setLastAppliedBlobsTs,
} from './backup'
import { durable } from './durable'

/**
 * Background probe cadence (env-tunable). The always-on interval loop is
 * now OPT-IN (V5_FRESHNESS_LOOP=true) and OFF by default: on Vercel Fluid
 * Compute a repeating timer keeps every warm instance alive 24/7 and burns
 * Fluid CPU Duration even with ZERO traffic — the exact usage spike we
 * need to avoid. Convergence is carried by the on-demand paths (miss
 * probes + read-path background probes), so an idle instance now costs
 * NOTHING.
 */
const PROBE_INTERVAL_MS = Number(process.env.V5_PROBE_INTERVAL_MS) || 20_000
/**
 * Minimum spacing between on-demand (miss-path) probes per instance —
 * bounds Telegram API load under miss bursts while keeping self-heal fast.
 */
const FRESHNESS_MIN_INTERVAL_MS = Number(process.env.V5_FRESHNESS_MIN_INTERVAL_MS) || 2_000

export interface ProbeResult {
  probed: boolean
  applied: boolean
  pointerTs?: number
  error?: string
}

interface SyncState {
  lastProbeAt: number
  lastProbeOk: boolean | null
  inFlight: Promise<ProbeResult> | null
  loopStarted: boolean
}

const globalForSync = globalThis as unknown as { __v5Sync?: SyncState }

function state(): SyncState {
  globalForSync.__v5Sync ??= { lastProbeAt: 0, lastProbeOk: null, inFlight: null, loopStarted: false }
  return globalForSync.__v5Sync
}

/** Freshness is a FILE-MODE concern — a remote store is shared by all instances. */
function syncActive(): boolean {
  return isFileMode() && isV5TelegramBackupEnabled()
}

/** Cheapest first: the bot bio; fall back to the pinned V4 index entry. */
async function readSharedPointer(): Promise<SnapshotPointer | null> {
  const bio = await getBioPointer()
  if (bio) return bio
  return getIndexPointer()
}

/**
 * Probe the shared snapshot pointer; when it is newer than the last snapshot
 * this instance applied, download + apply it. Coalesces concurrent callers
 * onto one in-flight probe. NEVER throws.
 */
export async function probeAndApplyIfNewer(): Promise<ProbeResult> {
  if (!syncActive()) return { probed: false, applied: false }
  const s = state()
  if (s.inFlight) return s.inFlight
  const run = (async (): Promise<ProbeResult> => {
    s.lastProbeAt = Date.now()
    try {
      const pointer = await readSharedPointer()
      s.lastProbeOk = Boolean(pointer)
      if (!pointer) return { probed: true, applied: false }
      // FASTEST CHANNEL first: a newer kv-delta doc (KBs) reconciles recent
      // KV writes/deletes (resource records, tombstones) in ~1-2s — the
      // window where listings served stale creates/resurrected deletes.
      let applied = false
      if (pointer.df && (pointer.dts ?? 0) > getLastAppliedDeltaTs()) {
        const delta = await applyKvDelta(pointer.df)
        if (delta.ok) applied = true
      }
      // Blobs channel next: a newer blobs-only snapshot (KBs) makes
      // just-finalized files servable without the 13MB full download.
      if (pointer.bf && (pointer.bts ?? 0) > getLastAppliedBlobsTs()) {
        const fast = await applyBlobsSnapshot(pointer.bf)
        if (fast.ok) applied = true
      }
      // FULL snapshot when newer (carries everything; also supersedes the
      // blobs channel — applying it advances the blobs ts too).
      if ((pointer.ts ?? 0) > getLastAppliedSnapshotTs()) {
        const restored = await restoreV5FromTelegram()
        if (restored.ok) {
          applied = true
          if ((pointer.bts ?? 0) > getLastAppliedBlobsTs()) setLastAppliedBlobsTs(pointer.bts ?? 0)
        }
        return {
          probed: true,
          applied,
          pointerTs: pointer.ts,
          error: restored.ok ? undefined : restored.reason,
        }
      }
      return { probed: true, applied, pointerTs: pointer.ts }
    } catch (err) {
      s.lastProbeOk = false
      return { probed: true, applied: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      s.inFlight = null
    }
  })()
  s.inFlight = run
  return run
}

/**
 * On-demand freshness for MISS paths (login lookup miss, register uniqueness
 * miss, bearer miss, kv read miss, blob lookup miss). Rate-limited to one
 * probe per FRESHNESS_MIN_INTERVAL_MS per instance; coalesces onto an
 * in-flight probe; NEVER throws and NEVER blocks the caller on failure.
 */
export async function ensureFreshness(opts: { force?: boolean } = {}): Promise<void> {
  if (!syncActive()) return
  const s = state()
  const now = Date.now()
  if (!opts.force && now - s.lastProbeAt < FRESHNESS_MIN_INTERVAL_MS) return
  s.lastProbeAt = now // claim the slot before awaiting (burst callers skip)
  try {
    await probeAndApplyIfNewer()
  } catch {
    /* freshness is best-effort — the local store still serves */
  }
}

/**
 * Freshness with bounded retries for AUTH writes racing the async snapshot
 * upload: register/password-change on instance A queues an auth snapshot
 * (upload takes ~1-2s); a login landing on instance B within that window
 * probes, sees the OLD pointer, and would 401. Retry the probe a few times
 * with short waits so the just-written account converges instead of failing.
 * Bounded (default 3 attempts × 450ms) and used ONLY on auth miss paths —
 * auth operations are rare, so this costs nothing under load.
 */
export async function ensureFreshnessRetry(
  attempts = Number(process.env.V5_AUTH_MISS_RETRIES) || 3,
  waitMs = 450,
): Promise<void> {
  for (let i = 0; i < Math.max(1, attempts); i++) {
    await ensureFreshness({ force: true })
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs))
  }
}

/**
 * Bounding STALE HITS (not just misses): an instance that already holds an
 * OLD value for a key would serve it forever — the miss probes never fire
 * because the lookup hits. Called from hot read paths (kvGet/kvPage); at
 * most one background probe per BACKGROUND_PROBE_MIN_INTERVAL_MS per
 * instance, durable-wrapped so the serverless invocation stays alive long
 * enough to finish the (possible) snapshot download+apply. The CURRENT
 * request may still serve data one snapshot behind; the next one converges.
 */
const BACKGROUND_PROBE_MIN_INTERVAL_MS = Number(process.env.V5_BG_PROBE_MIN_INTERVAL_MS) || 3_000

interface SyncBgGlobal {
  __v5SyncBgProbeAt?: number
}

export function maybeBackgroundProbe(): void {
  if (!syncActive()) return
  const g = globalThis as unknown as SyncBgGlobal
  const now = Date.now()
  if (now - (g.__v5SyncBgProbeAt ?? 0) < BACKGROUND_PROBE_MIN_INTERVAL_MS) return
  g.__v5SyncBgProbeAt = now
  durable(probeAndApplyIfNewer())
}

/**
 * Background convergence loop (file mode only) — OPT-IN via
 * V5_FRESHNESS_LOOP=true, OFF by default: a repeating timer keeps warm
 * serverless instances alive forever and burns Fluid CPU Duration with
 * zero traffic (every 20s tick = a Telegram API call = TLS + JSON CPU).
 * The on-demand probe paths (miss probes + read-path background probes)
 * carry convergence under real traffic, so the loop is only needed for
 * exotic always-stale-read workloads.
 */
export function startFreshnessLoop(): void {
  if (!syncActive()) return
  if (process.env.V5_FRESHNESS_LOOP !== 'true') return
  const s = state()
  if (s.loopStarted) return
  s.loopStarted = true
  const timer = setInterval(() => {
    void probeAndApplyIfNewer()
  }, PROBE_INTERVAL_MS)
  timer.unref?.()
}

/** Observability for /api/v5/health. */
export function freshnessStatus(): {
  active: boolean
  lastProbeAt: number | null
  lastProbeOk: boolean | null
  lastAppliedSnapshotTs: number | null
  probeIntervalMs: number
  missProbeMinIntervalMs: number
} {
  const s = state()
  return {
    active: syncActive(),
    lastProbeAt: s.lastProbeAt > 0 ? s.lastProbeAt : null,
    lastProbeOk: s.lastProbeOk,
    lastAppliedSnapshotTs: getLastAppliedSnapshotTs() || null,
    probeIntervalMs: PROBE_INTERVAL_MS,
    missProbeMinIntervalMs: FRESHNESS_MIN_INTERVAL_MS,
  }
}
