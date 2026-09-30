#!/usr/bin/env node
/**
 * Start the Next.js dev server as a detached daemon so it survives this
 * shell session. PID is written to .next-dev.pid; logs go to dev.log.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PID_FILE = path.join(ROOT, '.next-dev.pid')
const LOG_FILE = path.join(ROOT, 'dev.log')

// Refuse to double-start if a live PID is recorded.
try {
  const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
  if (old && process.kill(old, 0)) {
    console.log(`dev server already running (pid ${old})`)
    process.exit(0)
  }
} catch {}

const out = fs.openSync(LOG_FILE, 'a')
const child = spawn('bun', ['run', 'dev'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, out],
  env: process.env,
})

fs.writeFileSync(PID_FILE, String(child.pid))
child.unref()
console.log(`dev server detached (pid ${child.pid}); logs → dev.log`)
