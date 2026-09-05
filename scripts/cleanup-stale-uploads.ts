#!/usr/bin/env bun
/**
 * Onyx Base — stale-upload janitor + 502 self-heal script ("secret script").
 *
 * WHAT IT DOES
 * ────────────
 *  1. SWEEPS stale chunked-upload workspaces (default TTL 2h) from
 *     `<tmpdir>/onyxbase-uploads/` — protocol v2 is stateless, so /tmp only
 *     holds transient assembly dirs from crashed `complete` calls; abandoned
 *     transfers are cleaned from the TELEGRAM chat via /api/files/upload/abort.
 *  2. HEALTH-CHECKS the local dev server (default http://localhost:3000).
 *  3. If the server is DOWN (502 / connection refused) it KILLS zombie
 *     `next dev` processes hogging port 3000 and restarts a fresh one via
 *     `scripts/daemonize-next.js`. This is the automated recovery for the
 *     "app crashed after a large upload and gives 502 until manual restart"
 *     failure mode.
 *
 * USAGE
 * ─────
 *   bun scripts/cleanup-stale-uploads.ts             # sweep + health check
 *   bun scripts/cleanup-stale-uploads.ts --force     # sweep ignoring cooldown
 *   bun scripts/cleanup-stale-uploads.ts --watch 60  # loop every 60s (cron mode)
 *   BASE_URL=http://host:3000 bun scripts/cleanup-stale-uploads.ts
 *
 * CRON (self-hosted box, every 10 minutes):
 *   0-59/10 * * * * cd /path/to/onyx-base && bun scripts/cleanup-stale-uploads.ts >> /var/log/onyx-janitor.log 2>&1
 */

import { readdir, rm, stat, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawn } from 'child_process'

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const WATCH = args.includes('--watch')
const WATCH_INTERVAL_S = Number(args[args.indexOf('--watch') + 1] ?? 60) || 60
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

const UPLOAD_ROOT = path.join(os.tmpdir(), 'onyxbase-uploads')
const SESSION_TTL_MS = 2 * 60 * 60 * 1000

function log(msg: string) {
  console.log(`[janitor ${new Date().toISOString()}] ${msg}`)
}

// ─── 1. Sweep stale upload sessions ──────────────────────────────────────────

async function sweepUploads(force: boolean): Promise<number> {
  if (!existsSync(UPLOAD_ROOT)) return 0
  let removed = 0
  const now = Date.now()
  let entries: string[] = []
  try {
    entries = await readdir(UPLOAD_ROOT)
  } catch {
    return 0
  }
  for (const id of entries) {
    const dir = path.join(UPLOAD_ROOT, id)
    const s = await stat(dir).catch(() => null)
    if (!s || !s.isDirectory()) continue
    // Protocol v2 is stateless: /tmp holds only transient assembly workspaces
    // (removed in a `finally` by the complete route). Anything left here is
    // debris from a crashed `complete` — sweep on the same TTL.
    const stale = now - s.mtimeMs > SESSION_TTL_MS
    if (force || stale) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      removed++
      log(`removed workspace ${id}${stale ? ' (expired)' : ' (forced)'}`)
    }
  }
  // Recreate the root so the next upload's mkdir is cheap.
  await mkdir(UPLOAD_ROOT, { recursive: true }).catch(() => {})
  return removed
}

// ─── 2 + 3. Health check & 502 self-heal ─────────────────────────────────────

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch {
    return false
  }
}

function killZombiesOnPort(port: number): void {
  try {
    const pids = execSync(`fuser ${port}/tcp 2>/dev/null || true`, { encoding: 'utf8' }).trim()
    if (pids) {
      log(`killing zombie processes on :${port} → ${pids.split(/\s+/).join(', ')}`)
      execSync(`kill -9 ${pids.split(/\s+/).join(' ')} 2>/dev/null || true`)
    }
  } catch {
    /* fuser may be missing — best-effort */
  }
}

function restartDevServer(): void {
  const daemonize = '/home/z/my-project/scripts/daemonize-next.js'
  if (!existsSync(daemonize)) {
    log('daemonize-next.js not found — cannot auto-restart; manual restart needed.')
    return
  }
  try {
    log('restarting dev server via scripts/daemonize-next.js …')
    const child = spawn('node', [daemonize], {
      cwd: '/home/z/my-project',
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (err) {
    log(`restart failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function selfHeal(): Promise<void> {
  if (await isServerUp()) {
    log('server healthy ✓')
    return
  }
  log('server DOWN (502?) — initiating self-heal …')
  killZombiesOnPort(3000)
  restartDevServer()
  // Give it a grace period, then re-verify.
  for (let attempt = 1; attempt <= 6; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000))
    if (await isServerUp()) {
      log(`server recovered after restart (attempt ${attempt}) ✓`)
      return
    }
  }
  log('server still down after restart attempts — manual intervention required.')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runOnce() {
  const removed = await sweepUploads(FORCE)
  log(`swept ${removed} stale upload workspace(s)`)
  await selfHeal()
}

if (WATCH) {
  log(`watch mode — running every ${WATCH_INTERVAL_S}s (Ctrl+C to stop)`)
  void runOnce()
  setInterval(() => void runOnce(), WATCH_INTERVAL_S * 1000)
} else {
  runOnce().then(() => process.exit(0)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
