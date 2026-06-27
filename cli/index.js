#!/usr/bin/env node
// Onyx Base CLI — terminal client for the Telegram-backed key-value store.
//
// Pure Node.js ESM, no external dependencies. Runs on Node 18+ (uses global
// fetch) or Bun. Install globally with `npm i -g .` or run directly via
// `node cli/index.js ...` / `bun cli/index.js ...`.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { stdin as processStdin, stdout as processStdout } from 'node:process'

// ─────────────────────────────────────────────────────────────────────────────
// ANSI color helpers — kept tiny so the file stays dependency-free.
// Always no-op when stdout is not a TTY (so piping stays clean).
// ─────────────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  gray: isTTY ? '\x1b[90m' : '',
}
const c = (color, s) => `${C[color]}${s}${C.reset}`

// stderr dim helper (for type hints that must not pollute stdout)
const isTTYerr = process.stderr.isTTY
const Cerr = { dim: isTTYerr ? '\x1b[2m' : '', reset: isTTYerr ? '\x1b[0m' : '' }
const dimErr = (s) => `${Cerr.dim}${s}${Cerr.reset}`

// ─────────────────────────────────────────────────────────────────────────────
// Config — stored at ~/.onyx/config.json
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.onyx')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
// No localhost default — the server is a hosted service.
// Users set ONYX_URL or pass --server, or run `onyx login` which
// discovers the server from the dashboard's /api/config endpoint.
const DEFAULT_SERVER = ''

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeConfig(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  // Best-effort: tighten perms so other users can't read the API key.
  try {
    await fs.chmod(CONFIG_FILE, 0o600)
  } catch {
    /* ignore on platforms that don't support chmod */
  }
}

async function removeConfig() {
  try {
    await fs.unlink(CONFIG_FILE)
    return true
  } catch {
    return false
  }
}

/** Resolve the server URL: env var > config > default.
 *  Returns '' when nothing is configured.
 */
function resolveServer(cfg) {
  return process.env.ONYX_URL || (cfg && cfg.server) || DEFAULT_SERVER
}

/** Ensure a server URL is set; exit with guidance if not. */
function ensureServer(cfg) {
  const server = resolveServer(cfg)
  if (!server) {
    console.error(c('red', '✗ No Onyx Base server configured.'))
    console.error(c('dim', '  Set the ONYX_URL environment variable to the hosted backend, e.g.:'))
    console.error(c('dim', '    export ONYX_URL=https://your-onyx.example.com'))
    console.error(c('dim', '  Or pass --server <url> on your next command.'))
    console.error(c('dim', '  You can find the API base URL in the web dashboard → Docs → Quickstart.'))
    process.exit(1)
  }
  return server
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP — small fetch wrapper that throws on non-2xx with the server's message.
// ─────────────────────────────────────────────────────────────────────────────

async function request(method, serverUrl, pathname, { body, apiKey } = {}) {
  const url = `${serverUrl.replace(/\/$/, '')}${pathname}`
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    const e = new Error(`Could not reach Onyx Base server at ${serverUrl}`)
    e.code = 'NETWORK_ERROR'
    e.cause = err
    throw e
  }

  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }

  if (!res.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `HTTP ${res.status} ${res.statusText}`
    const e = new Error(message)
    e.status = res.status
    e.data = data
    throw e
  }
  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// Value coercion — mirrors src/lib/auth.ts on the server.
// ─────────────────────────────────────────────────────────────────────────────

function coerceValue(raw) {
  const trimmed = String(raw).trim()
  if (trimmed === '') return { value: '', type: 'string' }
  if (/^(true|false)$/i.test(trimmed)) {
    return { value: trimmed.toLowerCase() === 'true', type: 'boolean' }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { value: Number(trimmed), type: 'number' }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return { value: parsed, type: Array.isArray(parsed) ? 'array' : typeof parsed }
    } catch {
      /* fall through */
    }
  }
  return { value: trimmed, type: 'string' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing — minimal, no deps.
//   args: ["set", "coins", "500", "--collection", "default", "-v"]
//   → { positional: ["set","coins","500"], flags: { collection: "default", v: true } }
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--') && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--') && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pretty-printing helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskApiKey(key) {
  if (!key) return '(none)'
  if (key.length <= 16) return key
  return `${key.slice(0, 12)}…${key.slice(-4)}`
}

function formatValue(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v, null, 2)
}

// ─────────────────────────────────────────────────────────────────────────────
// File helpers (upload/list/download)
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * Parse a column spec for `onyx tables create --columns`.
 *
 * Two formats accepted:
 *   1. JSON array:   '[{"name":"id","type":"INTEGER","primaryKey":true},...]'
 *   2. Compact colon-separated (comma between columns):
 *      "id:INTEGER:pk:ai,title:TEXT:notnull,body:TEXT:default=hello"
 *
 * Compact tokens after name:TYPE:
 *   pk          → primaryKey: true
 *   ai          → autoIncrement: true (implies primaryKey)
 *   notnull     → nullable: false
 *   default=X   → default: X (string; numbers auto-coerced)
 */
function parseColumns(raw) {
  const trimmed = raw.trim()
  // JSON array format
  if (trimmed.startsWith('[')) {
    let arr
    try {
      arr = JSON.parse(trimmed)
    } catch {
      throw new Error('--columns JSON must be valid JSON.')
    }
    if (!Array.isArray(arr)) throw new Error('--columns JSON must be an array.')
    return arr.map((col, i) => {
      if (!col || typeof col !== 'object') throw new Error(`Column ${i}: must be an object.`)
      if (!col.name || typeof col.name !== 'string') throw new Error(`Column ${i}: "name" is required.`)
      if (!col.type || typeof col.type !== 'string') throw new Error(`Column ${i}: "type" is required.`)
      return {
        name: col.name,
        type: col.type,
        primaryKey: !!col.primaryKey,
        autoIncrement: !!col.autoIncrement,
        nullable: col.nullable !== false,
        default: col.default ?? null,
      }
    })
  }
  // Compact colon-separated format
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('No columns provided.')
  return parts.map((spec, i) => {
    const tokens = spec.split(':').map((s) => s.trim())
    const name = tokens[0]
    if (!name) throw new Error(`Column ${i}: name is required.`)
    const type = (tokens[1] || 'TEXT').toUpperCase()
    const col = { name, type, primaryKey: false, autoIncrement: false, nullable: true, default: null }
    for (let j = 2; j < tokens.length; j++) {
      const t = tokens[j].toLowerCase()
      if (t === 'pk') { col.primaryKey = true }
      else if (t === 'ai') { col.autoIncrement = true; col.primaryKey = true }
      else if (t === 'notnull' || t === 'nn') { col.nullable = false }
      else if (t.startsWith('default=')) {
        const val = t.slice(8)
        // Auto-coerce numbers
        col.default = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val
      }
    }
    return col
  })
}

/** Normalize access-mode strings: r/read → 'read', w/write → 'write', rw/readwrite → 'readwrite' */
function normalizeAccessMode(raw) {
  const v = String(raw).toLowerCase()
  if (v === 'r' || v === 'read' || v === 'ro') return 'read'
  if (v === 'w' || v === 'write' || v === 'wo') return 'write'
  if (v === 'rw' || v === 'readwrite' || v === 'r/w') return 'readwrite'
  return null
}

/**
 * Hand-rolled multipart/form-data POST for environments without global
 * FormData/Blob (older Node). Builds a single buffer and sends it with the
 * correct Content-Type + boundary.
 */
async function uploadMultipart(url, apiKey, buffer, fileName, label, isPrivate) {
  const boundary = 'onyx-' + crypto.randomBytes(16).toString('hex')
  const parts = []
  const CRLF = '\r\n'

  const filePartHead =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, '')}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}${CRLF}`
  parts.push(Buffer.from(filePartHead, 'utf8'), buffer, Buffer.from(CRLF, 'utf8'))

  if (label) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="label"${CRLF}${CRLF}` +
      `${label}${CRLF}`,
      'utf8',
    ))
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="public"${CRLF}${CRLF}` +
    `${isPrivate ? 'false' : 'true'}${CRLF}`,
    'utf8',
  ))
  parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))

  const body = Buffer.concat(parts)
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

const cmd = {
  async login(args) {
    const { flags } = parseArgs(args)
    const name = flags.name && typeof flags.name === 'string' ? flags.name : undefined
    const email = flags.email && typeof flags.email === 'string' ? flags.email : undefined
    // --server <url> overrides everything (env var, config, default).
    const serverFlag = flags.server && typeof flags.server === 'string' ? flags.server : null

    // `onyx login --key kv_live_xxx` — connect an existing account (e.g. one
    // created via the web signup form) without minting a new one. Validates the
    // key against /api/auth/verify and persists it locally.
    if (flags.key && typeof flags.key === 'string') {
      const key = flags.key.trim()
      if (!/^kv_live_/i.test(key)) {
        console.error(c('red', '✗ That does not look like a Onyx Base API key (expected kv_live_...).'))
        process.exit(1)
      }
      const existing = await readConfig()
      const server = serverFlag || ensureServer(existing)
      let data
      try {
        data = await request('POST', server, '/api/auth/verify', { apiKey: key })
      } catch (err) {
        if (err.status === 401) {
          console.error(c('red', '✗ That API key is invalid or revoked.'))
          console.error(c('dim', '  Copy the key from the web dashboard and try again.'))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      const cfg = { userId: data.userId, apiKey: key, server }
      await writeConfig(cfg)
      console.log(c('green', '✓ Connected to existing account'))
      console.log()
      console.log(`  ${c('cyan', 'User ID')}   ${data.userId}`)
      if (data.name) console.log(`  ${c('cyan', 'Name')}      ${data.name}`)
      console.log(`  ${c('cyan', 'API Key')}   ${c('yellow', maskApiKey(key))}`)
      console.log(`  ${c('cyan', 'Server')}    ${server}`)
      console.log()
      console.log(c('dim', `Saved to ~/.onyx/config.json`))
      console.log(c('dim', `You can now run: onyx set hello "world"`))
      return
    }

    const existing = await readConfig()
    if (existing && existing.apiKey && !flags.new) {
      const server = ensureServer(existing)
      console.log(c('yellow', '! Already logged in'))
      console.log()
      console.log(`  ${c('cyan', 'User ID')}   ${existing.userId}`)
      console.log(`  ${c('cyan', 'API Key')}   ${c('yellow', existing.apiKey)}`)
      console.log(`  ${c('cyan', 'Server')}    ${server}`)
      console.log()
      console.log(c('dim', `  To connect a different key instead, run \`onyx login --key kv_live_xxx\`.`))
      console.log(c('dim', `  To create a new account instead, run \`onyx login --new\`.`))
      console.log(c('dim', `  To clear this first, run \`onyx logout\`.`))
      return
    }

    const server = serverFlag || ensureServer(existing)
    const payload = { source: 'cli' }
    if (name) payload.name = name
    if (email) payload.email = email

    let data
    try {
      data = await request('POST', server, '/api/auth/register', { body: payload })
    } catch (err) {
      return failNetwork(err, server)
    }

    const cfg = { userId: data.userId, apiKey: data.apiKey, server }
    await writeConfig(cfg)

    console.log(c('green', '✓ Account created'))
    console.log()
    console.log(`  ${c('cyan', 'User ID')}   ${data.userId}`)
    if (data.name) console.log(`  ${c('cyan', 'Name')}      ${data.name}`)
    if (data.email) console.log(`  ${c('cyan', 'Email')}     ${data.email}`)
    console.log(`  ${c('cyan', 'API Key')}   ${c('yellow', data.apiKey)}`)
    console.log()
    console.log(c('dim', `Saved to ~/.onyx/config.json`))
    console.log(c('dim', `Use this API key to log into the web dashboard.`))
    console.log(c('dim', `Or sign up on the web and connect with: onyx login --key <api-key>`))
  },

  async set(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const key = positional[0]
    const rawValue = positional[1]
    if (!key || rawValue === undefined) {
      console.error(c('red', '✗ Usage: onyx set <key> <value> [--collection <name>]'))
      process.exit(1)
    }
    const collection = flags.collection || 'default'
    const { value, type } = coerceValue(rawValue)

    let data
    try {
      data = await request('POST', ensureServer(cfg), '/v1/set', {
        body: { key, value, collection },
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      return failNetwork(err, ensureServer(cfg))
    }

    console.log(c('green', '✓ Saved'))
    const shown = typeof value === 'string' ? value : JSON.stringify(value)
    console.log(c('dim', `  ${data.key} = ${shown} (${data.type || type}) in ${data.collection || collection}`))
  },

  async get(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const key = positional[0]
    if (!key) {
      console.error(c('red', '✗ Usage: onyx get <key> [--collection <name>]'))
      process.exit(1)
    }
    const collection = flags.collection || 'default'
    const qs = `?collection=${encodeURIComponent(collection)}`

    let data
    try {
      data = await request('GET', ensureServer(cfg), `/v1/get/${encodeURIComponent(key)}${qs}`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      if (err.status === 404) {
        console.error(c('red', `✗ Key "${key}" not found`))
        process.exit(1)
      }
      return failNetwork(err, ensureServer(cfg))
    }

    const value = data.value
    // stdout: just the value (pipe-friendly)
    if (value === null) console.log('null')
    else if (typeof value === 'string') console.log(value)
    else if (typeof value === 'number' || typeof value === 'boolean') console.log(value)
    else console.log(JSON.stringify(value, null, 2))
    // stderr: type hint (does not pollute stdout)
    process.stderr.write(dimErr(`# (${data.type || typeof value}) collection=${data.collection || collection}\n`))
  },

  async delete(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const key = positional[0]
    if (!key) {
      console.error(c('red', '✗ Usage: onyx delete <key> [--collection <name>]'))
      process.exit(1)
    }
    const collection = flags.collection || 'default'
    const qs = `?collection=${encodeURIComponent(collection)}`

    try {
      await request('DELETE', ensureServer(cfg), `/v1/delete/${encodeURIComponent(key)}${qs}`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      if (err.status === 404) {
        console.error(c('red', `✗ Key "${key}" not found`))
        process.exit(1)
      }
      return failNetwork(err, ensureServer(cfg))
    }
    console.log(c('green', `✓ Deleted ${key}`))
  },

  async list(args) {
    const { flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const collection = flags.collection || 'default'
    const verbose = Boolean(flags.verbose || flags.v)
    const qs = `?collection=${encodeURIComponent(collection)}`

    let data
    try {
      data = await request('GET', ensureServer(cfg), `/v1/list${qs}`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      return failNetwork(err, ensureServer(cfg))
    }

    const keys = data.keys || []
    if (verbose) {
      // For verbose, hit export to enrich with types/values.
      let enriched = {}
      try {
        const exp = await request('GET', ensureServer(cfg), `/v1/export${qs}`, {
          apiKey: cfg.apiKey,
        })
        enriched = exp.data || {}
      } catch {
        /* fall back to keys-only */
      }
      const rows = keys.map((k) => {
        const v = enriched[k]
        const t = v === undefined ? '-' : Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
        return { key: k, type: t, collection }
      })
      const kWidth = Math.max(3, ...rows.map((r) => r.key.length))
      const tWidth = Math.max(4, ...rows.map((r) => r.type.length))
      console.log(`  ${'KEY'.padEnd(kWidth)}  ${'TYPE'.padEnd(tWidth)}  COLLECTION`)
      for (const r of rows) {
        console.log(`  ${c('cyan', r.key.padEnd(kWidth))}  ${c('yellow', r.type.padEnd(tWidth))}  ${c('dim', r.collection)}`)
      }
    } else {
      for (const k of keys) console.log(k)
    }
    process.stderr.write(dimErr(`# ${data.count ?? keys.length} keys\n`))
  },

  async export(args) {
    const { flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const collection = flags.collection || 'default'
    const output = typeof flags.output === 'string' ? flags.output : null
    const qs = `?collection=${encodeURIComponent(collection)}`

    let data
    try {
      data = await request('GET', ensureServer(cfg), `/v1/export${qs}`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      return failNetwork(err, ensureServer(cfg))
    }

    const json = JSON.stringify(data.data || {}, null, 2)
    if (output) {
      await fs.writeFile(output, json + '\n', 'utf8')
      const count = Object.keys(data.data || {}).length
      console.log(c('green', `✓ Exported ${count} keys to ${output}`))
    } else {
      console.log(json)
    }
  },

  // ─── File storage (upload/list/download via the /v1/files API) ─────────────
  //
  // `onyx upload <path>` streams a file to the server's /v1/files endpoint
  // (multipart/form-data). ANY extension is accepted (exe, txt, png, jpg, zip,
  // video, …). The server mirrors it to Telegram and returns a permanent
  // /f/<fileId> link that works without auth.
  async upload(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const filePath = positional[0]
    if (!filePath) {
      console.error(c('red', '✗ Usage: onyx upload <path-to-file> [--label "note"] [--private]'))
      process.exit(1)
    }

    const server = ensureServer(cfg)
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat || !stat.isFile()) {
      console.error(c('red', `✗ File not found: ${filePath}`))
      process.exit(1)
    }
    if (stat.size > 2 * 1024 * 1024 * 1024) {
      console.error(c('red', '✗ File exceeds the 2 GB per-file limit.'))
      process.exit(1)
    }

    const buffer = await fs.readFile(filePath)
    const basename = path.basename(filePath)
    // Node 18 has no global FormData/Blob in older builds; fall back to a
    // hand-built multipart body when the globals are missing.
    const label = typeof flags.label === 'string' ? flags.label : ''
    const isPrivate = !!flags.private
    const url = `${server.replace(/\/$/, '')}/v1/files`

    let res
    try {
      if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
        const form = new FormData()
        form.append('file', new Blob([buffer]), basename)
        if (label) form.append('label', label)
        form.append('public', isPrivate ? 'false' : 'true')
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          body: form,
        })
      } else {
        // Hand-rolled multipart/form-data for older Node.
        res = await uploadMultipart(url, cfg.apiKey, buffer, basename, label, isPrivate)
      }
    } catch (err) {
      return failNetwork(err, server)
    }

    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    if (!res.ok) {
      console.error(c('red', `✗ Upload failed: ${data?.error || `HTTP ${res.status}`}`))
      process.exit(1)
    }
    const f = data?.file
    console.log(c('green', `✓ Uploaded ${basename} (${formatBytes(stat.size)})`))
    console.log(`  ${c('dim', 'link:')}   ${f?.downloadUrl ?? '(no link returned)'}`)
    if (f?.fileId) console.log(`  ${c('dim', 'id:')}     ${f.fileId}`)
  },

  async files(args) {
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    let data
    try {
      data = await request('GET', server, '/v1/files', { apiKey: cfg.apiKey })
    } catch (err) {
      return failNetwork(err, server)
    }
    const files = data?.files ?? []
    if (files.length === 0) {
      console.log(c('dim', '  No files stored yet. Run `onyx upload <path>` to add one.'))
      return
    }
    console.log(c('bold', `  ${files.length} file(s) · ${formatBytes(files.reduce((s, f) => s + f.size, 0))} total`))
    console.log()
    for (const f of files) {
      console.log(`  ${c('cyan', f.fileName)}  ${c('dim', `(${formatBytes(f.size)})`)}  ${c('dim', timeAgo(f.createdAt))}`)
      console.log(`  ${c('gray', f.downloadUrl)}`)
      console.log()
    }
  },

  async download(args) {
    const { positional } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const fileId = positional[0]
    if (!fileId) {
      console.error(c('red', '✗ Usage: onyx download <f_xxx | url> [output-path]'))
      process.exit(1)
    }
    // Accept either a bare file id or a full /f/<id> URL.
    const id = fileId.includes('/f/') ? fileId.split('/f/').pop().split('?')[0] : fileId
    const server = ensureServer(cfg)
    const url = `${server.replace(/\/$/, '')}/f/${id}`
    const outPath = positional[1] || path.basename(url) || `onyx-${id}`
    let res
    try {
      res = await fetch(url)
    } catch (err) {
      return failNetwork(err, server)
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error(c('red', `✗ Download failed: HTTP ${res.status} ${t.slice(0, 200)}`))
      process.exit(1)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(outPath, buf)
    console.log(c('green', `✓ Saved ${formatBytes(buf.length)} → ${outPath}`))
  },

  async whoami() {
    const cfg = await readConfig()
    if (!cfg || !cfg.apiKey) {
      console.error(c('red', '✗ Not logged in. Run `onyx login` first.'))
      process.exit(1)
    }
    const server = ensureServer(cfg)
    console.log(`User ID:  ${cfg.userId}`)
    console.log(`API Key:  ${maskApiKey(cfg.apiKey)}`)
    console.log(`Server:   ${server}`)
    console.log(c('dim', `Config:  ~/.onyx/config.json`))
  },

  async logout() {
    const existed = await removeConfig()
    if (existed) {
      console.log(c('green', '✓ Logged out'))
    } else {
      console.log(c('dim', 'Already logged out (no config found).'))
    }
  },

  async health() {
    const cfg = await requireAuth()
    if (!cfg) return
    let data
    try {
      data = await request('GET', ensureServer(cfg), '/v1/health', {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      return failNetwork(err, ensureServer(cfg))
    }
    console.log(c('green', `✓ Onyx Base is ${data.status || 'ok'}`))
    console.log()
    console.log(`  ${c('cyan', 'User')}         ${data.user}`)
    if (data.storage) {
      console.log(`  ${c('cyan', 'Records')}     ${data.storage.records}`)
      console.log(`  ${c('cyan', 'Collections')} ${data.storage.collections}`)
      console.log(`  ${c('cyan', 'Engine')}      ${data.storage.engine}`)
    }
    if (data.telegram) {
      const status = data.telegram.configured ? c('green', 'connected') : c('red', 'not configured')
      console.log(`  ${c('cyan', 'Telegram')}    ${status}` +
        (data.telegram.bot ? `  (bot: ${data.telegram.bot})` : ''))
    }
  },

  // ─── Collections ──────────────────────────────────────────────────────────
  //   onyx collections                    → list (name, count, created)
  //   onyx collections create <name>      → POST /v1/collections
  //   onyx collections delete <name>      → DELETE /v1/collections/<name>
  async collections(args) {
    const { positional } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const sub = positional[0]

    // Default + explicit `list` → list all collections.
    if (!sub || sub === 'list') {
      let data
      try {
        data = await request('GET', server, '/v1/collections', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const cols = data?.collections ?? []
      if (cols.length === 0) {
        console.log(c('dim', '  No collections yet. Run `onyx collections create <name>` to add one.'))
        return
      }
      const nameW = Math.max(4, ...cols.map((x) => (x.name || '').length))
      console.log(`  ${'NAME'.padEnd(nameW)}  COUNT  CREATED`)
      for (const x of cols) {
        console.log(`  ${c('cyan', (x.name || '').padEnd(nameW))}  ${String(x.records ?? 0).padStart(5)}  ${c('dim', timeAgo(x.createdAt))}`)
      }
      process.stderr.write(dimErr(`# ${data?.count ?? cols.length} collections\n`))
      return
    }

    if (sub === 'create') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx collections create <name>'))
        process.exit(1)
      }
      try {
        await request('POST', server, '/v1/collections', {
          body: { name },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Created collection ${name}`))
      return
    }

    if (sub === 'delete') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx collections delete <name>'))
        process.exit(1)
      }
      let data
      try {
        data = await request('DELETE', server, `/v1/collections/${encodeURIComponent(name)}`, {
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 400 || err.status === 404) {
          console.error(c('red', `✗ ${err.message}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      const removed = data?.removed ? c('dim', ` (${data.removed} records removed)`) : ''
      console.log(c('green', `✓ Deleted collection ${name}`) + removed)
      return
    }

    console.error(c('red', `✗ Unknown subcommand: onyx collections ${sub}`))
    console.error(c('dim', `  Usage: onyx collections [list|create <name>|delete <name>]`))
    process.exit(1)
  },

  // ─── Stats ─────────────────────────────────────────────────────────────────
  //   onyx stats → GET /v1/stats → print each stat with colored label
  async stats() {
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    let data
    try {
      data = await request('GET', server, '/v1/stats', { apiKey: cfg.apiKey })
    } catch (err) {
      return failNetwork(err, server)
    }
    const s = data?.stats || {}
    console.log(c('bold', '  Account statistics'))
    console.log(`  ${c('cyan', 'User'.padEnd(16))} ${data?.user ?? ''}`)
    const rows = [
      ['records', s.records ?? 0],
      ['collections', s.collections ?? 0],
      ['apiKeys', s.apiKeys ?? 0],
      ['logs', s.logs ?? 0],
      ['files', s.files ?? 0],
      ['storageBytes', formatBytes(s.storageBytes ?? 0)],
      ['fileBytes', formatBytes(s.fileBytes ?? 0)],
    ]
    for (const [k, v] of rows) {
      console.log(`  ${c('cyan', k.padEnd(16))} ${v}`)
    }
    const byAction = s.activityByAction || {}
    const keys = Object.keys(byAction)
    if (keys.length) {
      console.log()
      console.log(c('dim', '  Activity (last 7d, by action):'))
      for (const k of keys.sort((a, b) => byAction[b] - byAction[a])) {
        console.log(`  ${c('yellow', k.padEnd(20))} ${byAction[k]}`)
      }
    }
  },

  // ─── Logs ──────────────────────────────────────────────────────────────────
  //   onyx logs [--limit N] [--action filter] → GET /v1/logs
  async logs(args) {
    const { flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const limitN = Number(flags.limit)
    const limit = Number.isFinite(limitN) && limitN > 0 ? Math.floor(limitN) : 20
    const actionFilter = typeof flags.action === 'string' ? flags.action : null
    const params = new URLSearchParams({ limit: String(limit) })
    if (actionFilter) params.set('action', actionFilter)

    let data
    try {
      data = await request('GET', server, `/v1/logs?${params}`, { apiKey: cfg.apiKey })
    } catch (err) {
      return failNetwork(err, server)
    }
    const logs = data?.logs ?? []
    if (logs.length === 0) {
      console.log(c('dim', '  No log entries yet.'))
      return
    }
    console.log(
      `  ${'TIME'.padEnd(11)}  ${'ACTION'.padEnd(18)}  ${'KEY'.padEnd(18)}  ${'SOURCE'.padEnd(9)}  DETAIL`,
    )
    for (const l of logs) {
      const t = timeAgo(l.createdAt).padEnd(11)
      const a = (l.action ?? '').padEnd(18)
      const k = (l.key ?? '-').padEnd(18)
      const src = (l.source ?? '').padEnd(9)
      console.log(`  ${c('dim', t)}  ${c('yellow', a)}  ${c('cyan', k)}  ${c('gray', src)}  ${l.detail ?? ''}`)
    }
    const suffix = actionFilter ? ` (filter: ${actionFilter})` : ''
    process.stderr.write(dimErr(`# ${data?.count ?? logs.length} entries${suffix}\n`))
  },

  // ─── File link / revoke / delete ──────────────────────────────────────────
  //
  //   onyx file-link <fileId> [--force]      → POST /v1/files/<id>/link
  //   onyx file-revoke <fileId>              → POST /v1/files/<id>/revoke
  //   onyx file-delete <fileId> [--yes]      → DELETE /v1/files/<id>
  'file-link': async function fileLink(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const fileId = positional[0]
    if (!fileId) {
      console.error(c('red', '✗ Usage: onyx file-link <fileId> [--force]'))
      process.exit(1)
    }
    const server = ensureServer(cfg)
    const qs = flags.force === true ? '?force=1' : ''
    let data
    try {
      data = await request('POST', server, `/v1/files/${encodeURIComponent(fileId)}/link${qs}`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      if (err.status === 404) {
        console.error(c('red', `✗ File not found: ${fileId}`))
        process.exit(1)
      }
      return failNetwork(err, server)
    }
    console.log(c('green', `✓ Link minted for ${data?.file?.fileName ?? fileId}`))
    console.log(`  ${c('dim', 'url:')}     ${data?.url ?? '(none)'}`)
    if (data?.proxyUrl) console.log(`  ${c('dim', 'proxy:')}   ${data.proxyUrl}`)
    const mins = data?.expiresInSec ? Math.max(1, Math.ceil(data.expiresInSec / 60)) : '?'
    console.log(`  ${c('dim', 'expires:')} Valid for ${mins} min`)
    if (data?.file) console.log(`  ${c('dim', 'size:')}    ${formatBytes(data.file.size ?? 0)}`)
  },

  'file-revoke': async function fileRevoke(args) {
    const { positional } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const fileId = positional[0]
    if (!fileId) {
      console.error(c('red', '✗ Usage: onyx file-revoke <fileId>'))
      process.exit(1)
    }
    const server = ensureServer(cfg)
    let data
    try {
      data = await request('POST', server, `/v1/files/${encodeURIComponent(fileId)}/revoke`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      if (err.status === 404) {
        console.error(c('red', `✗ File not found: ${fileId}`))
        process.exit(1)
      }
      return failNetwork(err, server)
    }
    console.log(c('green', `✓ Revoked cached link for ${fileId}`))
    if (data?.note) console.log(c('dim', `  ${data.note}`))
  },

  'file-delete': async function fileDelete(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const fileId = positional[0]
    if (!fileId) {
      console.error(c('red', '✗ Usage: onyx file-delete <fileId> [--yes]'))
      process.exit(1)
    }
    const server = ensureServer(cfg)
    if (flags.yes !== true) {
      const answer = await confirm(`Permanently delete file ${fileId}? (y/N) `)
      if (answer !== 'y' && answer !== 'yes') {
        console.log(c('dim', '  Aborted.'))
        return
      }
    }
    try {
      await request('DELETE', server, `/v1/files/${encodeURIComponent(fileId)}`, {
        apiKey: cfg.apiKey,
      })
    } catch (err) {
      if (err.status === 404) {
        console.error(c('red', `✗ File not found: ${fileId}`))
        process.exit(1)
      }
      return failNetwork(err, server)
    }
    console.log(c('green', `✓ Deleted file ${fileId}`))
  },

  // ─── Share tokens ──────────────────────────────────────────────────────────
  //   onyx share                                    → list
  //   onyx share list                               → GET /api/dashboard/share-tokens
  //   onyx share create <collection> <key>          → POST
  //   onyx share revoke <id>                        → DELETE
  async share(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const sub = positional[0]

    if (!sub || sub === 'list') {
      let data
      try {
        data = await request('GET', server, '/api/dashboard/share-tokens', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const tokens = data?.shareTokens ?? []
      if (tokens.length === 0) {
        console.log(c('dim', '  No share tokens yet. Run `onyx share create <collection> <key>` to add one.'))
        return
      }
      console.log(
        `  ${'COLLECTION'.padEnd(14)}  ${'KEY'.padEnd(20)}  ${'MODE'.padEnd(11)}  ${'LABEL'.padEnd(20)}  TOKEN`,
      )
      for (const t of tokens) {
        console.log(
          `  ${c('cyan', (t.collection ?? '').padEnd(14))}  ` +
          `${c('yellow', (t.key ?? '').padEnd(20))}  ` +
          `${(t.mode ?? '').padEnd(11)}  ` +
          `${(t.label ?? '-').padEnd(20)}  ` +
          `${c('gray', t.token ?? '')}`,
        )
      }
      process.stderr.write(dimErr(`# ${tokens.length} share token(s)\n`))
      return
    }

    if (sub === 'create') {
      const collection = positional[1]
      const key = positional[2]
      if (!collection || !key) {
        console.error(c('red', '✗ Usage: onyx share create <collection> <key> [--mode read|write|readwrite] [--label "note"]'))
        process.exit(1)
      }
      const body = { collection, key }
      if (typeof flags.mode === 'string') body.mode = flags.mode
      if (typeof flags.label === 'string') body.label = flags.label
      let data
      try {
        data = await request('POST', server, '/api/dashboard/share-tokens', {
          body,
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        return failNetwork(err, server)
      }
      const t = data?.shareToken
      console.log(c('green', '✓ Created share token'))
      console.log(`  ${c('dim', 'token:')}      ${t?.token ?? ''}`)
      console.log(`  ${c('dim', 'collection:')} ${t?.collection ?? collection}`)
      console.log(`  ${c('dim', 'key:')}        ${t?.key ?? key}`)
      console.log(`  ${c('dim', 'mode:')}       ${t?.mode ?? 'read'}`)
      if (t?.label) console.log(`  ${c('dim', 'label:')}      ${t.label}`)
      return
    }

    if (sub === 'revoke') {
      const id = positional[1]
      if (!id) {
        console.error(c('red', '✗ Usage: onyx share revoke <id>'))
        process.exit(1)
      }
      try {
        await request('DELETE', server, `/api/dashboard/share-tokens/${encodeURIComponent(id)}`, {
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ Share token not found: ${id}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Revoked share token ${id}`))
      return
    }

    console.error(c('red', `✗ Unknown subcommand: onyx share ${sub}`))
    console.error(c('dim', `  Usage: onyx share [list|create <collection> <key>|revoke <id>]`))
    process.exit(1)
  },

  // ─── Telegram config ───────────────────────────────────────────────────────
  //   onyx telegram-config              → view
  //   onyx telegram-config set          → set (--chat-id, --bot-token, --label)
  //   onyx telegram-config clear        → clear custom config
  //
  // NOTE: the server route implements PUT (not POST) for set — we use PUT so
  // the command actually works against the live API.
  'telegram-config': async function telegramConfig(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const sub = positional[0]

    if (!sub || sub === 'view') {
      let data
      try {
        data = await request('GET', server, '/api/dashboard/telegram-config', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      console.log(`  ${c('cyan', 'Env Chat ID'.padEnd(22))}        ${data?.envChatId || '(none)'}`)
      console.log(`  ${c('cyan', 'Effective Chat ID'.padEnd(22))}  ${data?.effectiveChatId || '(none)'}`)
      console.log(`  ${c('cyan', 'Env Bot Configured'.padEnd(22))} ${data?.envBotConfigured ? c('green', 'yes') : c('red', 'no')}`)
      console.log(`  ${c('cyan', 'Custom Bot Token'.padEnd(22))}   ${data?.hasCustomBotToken ? c('green', 'yes') : c('dim', 'no')}`)
      if (data?.customConfig) {
        console.log(`  ${c('cyan', 'Custom Chat ID'.padEnd(22))}   ${data.customConfig.chatId}`)
        if (data.customConfig.label) console.log(`  ${c('cyan', 'Custom Label'.padEnd(22))}    ${data.customConfig.label}`)
        console.log(`  ${c('cyan', 'Updated'.padEnd(22))}          ${timeAgo(data.customConfig.updatedAt)}`)
      }
      return
    }

    if (sub === 'set') {
      const chatId = typeof flags['chat-id'] === 'string' ? flags['chat-id'].trim() : null
      const botToken = typeof flags['bot-token'] === 'string' ? flags['bot-token'].trim() : undefined
      const label = typeof flags.label === 'string' ? flags.label.trim() : null
      if (!chatId) {
        console.error(c('red', '✗ Usage: onyx telegram-config set --chat-id <id> [--bot-token <token>] [--label "note"]'))
        process.exit(1)
      }
      const body = { chatId }
      if (botToken !== undefined) body.botToken = botToken
      if (label) body.label = label
      let data
      try {
        data = await request('PUT', server, '/api/dashboard/telegram-config', {
          body,
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        return failNetwork(err, server)
      }
      console.log(c('green', '✓ Telegram config saved'))
      console.log(`  ${c('dim', 'chat id:')}  ${data?.customConfig?.chatId ?? chatId}`)
      if (data?.customConfig?.label) console.log(`  ${c('dim', 'label:')}    ${data.customConfig.label}`)
      if (data?.telegram?.ok) console.log(`  ${c('dim', 'ping:')}     ${c('green', 'ok')}`)
      return
    }

    if (sub === 'clear') {
      try {
        await request('DELETE', server, '/api/dashboard/telegram-config', {
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        return failNetwork(err, server)
      }
      console.log(c('green', '✓ Telegram config cleared (reverted to env defaults)'))
      return
    }

    console.error(c('red', `✗ Unknown subcommand: onyx telegram-config ${sub}`))
    console.error(c('dim', `  Usage: onyx telegram-config [view|set|clear]`))
    process.exit(1)
  },

  // ─── API keys ──────────────────────────────────────────────────────────────
  //   onyx api-keys                       → list
  //   onyx api-keys create <name>         → POST (prints FULL key)
  //   onyx api-keys revoke <id>           → DELETE
  'api-keys': async function apiKeys(args) {
    const { positional } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const sub = positional[0]

    if (!sub || sub === 'list') {
      let data
      try {
        data = await request('GET', server, '/api/dashboard/api-keys', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const keys = data?.apiKeys ?? []
      if (keys.length === 0) {
        console.log(c('dim', '  No API keys yet. Run `onyx api-keys create <name>` to add one.'))
        return
      }
      console.log(
        `  ${'NAME'.padEnd(20)}  ${'KEY'.padEnd(28)}  ${'CREATED'.padEnd(11)}  ${'LAST USED'.padEnd(11)}  STATUS`,
      )
      for (const k of keys) {
        const status = k.revoked ? c('red', 'revoked') : c('green', 'active')
        const last = k.lastUsedAt ? timeAgo(k.lastUsedAt) : '-'
        console.log(
          `  ${c('cyan', (k.name ?? '').padEnd(20))}  ` +
          `${c('yellow', maskApiKey(k.key).padEnd(28))}  ` +
          `${c('dim', timeAgo(k.createdAt).padEnd(11))}  ` +
          `${c('dim', last.padEnd(11))}  ${status}`,
        )
      }
      process.stderr.write(dimErr(`# ${keys.length} API key(s)\n`))
      return
    }

    if (sub === 'create') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx api-keys create <name>'))
        process.exit(1)
      }
      let data
      try {
        data = await request('POST', server, '/api/dashboard/api-keys', {
          body: { name },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        return failNetwork(err, server)
      }
      const k = data?.apiKey
      console.log(c('green', '✓ Created API key'))
      console.log(`  ${c('dim', 'name:')}    ${k?.name ?? name}`)
      console.log(`  ${c('dim', 'id:')}      ${k?.id ?? ''}`)
      console.log(`  ${c('yellow', 'key:')}     ${k?.key ?? ''}`)
      console.log(c('dim', '  (Copy this key now — it will not be shown in full again.)'))
      return
    }

    if (sub === 'revoke') {
      const id = positional[1]
      if (!id) {
        console.error(c('red', '✗ Usage: onyx api-keys revoke <id>'))
        process.exit(1)
      }
      try {
        await request('DELETE', server, `/api/dashboard/api-keys/${encodeURIComponent(id)}`, {
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ API key not found: ${id}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Revoked API key ${id}`))
      return
    }

    console.error(c('red', `✗ Unknown subcommand: onyx api-keys ${sub}`))
    console.error(c('dim', `  Usage: onyx api-keys [list|create <name>|revoke <id>]`))
    process.exit(1)
  },

  // ─── Admin (requires an onyxbase_ key) ─────────────────────────────────────
  //   onyx admin users                       → GET /api/admin/users
  //   onyx admin user <id>                   → GET /api/admin/users/<id>
  //   onyx admin files                       → GET /api/admin/files
  //   onyx admin promote <kv_live_key>       → POST /api/admin/promote
  //   onyx admin admins                      → GET /api/admin/admins
  async admin(args) {
    const { positional } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const sub = positional[0]

    // All admin endpoints require an onyxbase_ key.
    if (!cfg.apiKey || !cfg.apiKey.startsWith('onyxbase_')) {
      console.error(c('red', '✗ Admin commands require an onyxbase_ key.'))
      console.error(c('dim', `  Run \`onyx login --key onyxbase_…\` to connect an admin key.`))
      process.exit(1)
    }

    if (sub === 'users') {
      let data
      try {
        data = await request('GET', server, '/api/admin/users', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const users = data?.users ?? []
      if (users.length === 0) {
        console.log(c('dim', '  No users yet.'))
        return
      }
      console.log(
        `  ${'USER ID'.padEnd(20)}  ${'NAME'.padEnd(18)}  ${'EMAIL'.padEnd(28)}  ${'PLAN'.padEnd(8)}  RECORDS  CREATED`,
      )
      for (const u of users) {
        const rec = u.stats?.records ?? 0
        console.log(
          `  ${c('cyan', (u.userId ?? '').padEnd(20))}  ` +
          `${(u.name ?? '-').padEnd(18)}  ` +
          `${(u.email ?? '-').padEnd(28)}  ` +
          `${(u.plan ?? '-').padEnd(8)}  ` +
          `${String(rec).padStart(7)}  ` +
          `${c('dim', timeAgo(u.createdAt))}`,
        )
      }
      process.stderr.write(dimErr(`# ${users.length} user(s)\n`))
      return
    }

    if (sub === 'user') {
      const id = positional[1]
      if (!id) {
        console.error(c('red', '✗ Usage: onyx admin user <id>'))
        process.exit(1)
      }
      let data
      try {
        data = await request('GET', server, `/api/admin/users/${encodeURIComponent(id)}`, {
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ User not found: ${id}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      const u = data?.user
      console.log(c('bold', '  User details'))
      console.log(`  ${c('cyan', 'User ID'.padEnd(12))} ${u?.userId ?? ''}`)
      console.log(`  ${c('cyan', 'Name'.padEnd(12))}     ${u?.name ?? '-'}`)
      console.log(`  ${c('cyan', 'Email'.padEnd(12))}    ${u?.email ?? '-'}`)
      console.log(`  ${c('cyan', 'Plan'.padEnd(12))}     ${u?.plan ?? '-'}`)
      console.log(`  ${c('cyan', 'Created'.padEnd(12))}  ${u?.createdAt ? timeAgo(u.createdAt) : '-'}`)
      if (Array.isArray(data?.apiKeys) && data.apiKeys.length) {
        console.log()
        console.log(c('dim', `  API keys (${data.apiKeys.length}):`))
        for (const k of data.apiKeys) {
          const status = k.revoked ? c('red', 'revoked') : c('green', 'active')
          console.log(`    ${c('yellow', k.keyPrefix ?? '')}  ${k.name ?? ''}  ${status}`)
        }
      }
      if (Array.isArray(data?.collections) && data.collections.length) {
        console.log()
        console.log(c('dim', `  Collections (${data.collections.length}):`))
        for (const col of data.collections) {
          console.log(`    ${c('cyan', col.name ?? col.id ?? '')}  ${col.records ?? 0} records`)
        }
      }
      if (Array.isArray(data?.files) && data.files.length) {
        console.log()
        console.log(c('dim', `  Files (${data.files.length}):`))
        for (const f of data.files) {
          console.log(`    ${c('cyan', f.fileName ?? f.fileId ?? '')}  ${formatBytes(f.size ?? 0)}`)
        }
      }
      return
    }

    if (sub === 'files') {
      let data
      try {
        data = await request('GET', server, '/api/admin/files', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const files = data?.files ?? []
      if (files.length === 0) {
        console.log(c('dim', '  No files yet.'))
        return
      }
      console.log(
        `  ${'FILE ID'.padEnd(20)}  ${'NAME'.padEnd(28)}  ${'SIZE'.padEnd(10)}  ${'OWNER'.padEnd(20)}  CREATED`,
      )
      let total = 0
      for (const f of files) {
        total += f.size ?? 0
        const owner = f.owner?.userId ?? '-'
        console.log(
          `  ${c('cyan', (f.fileId ?? '').padEnd(20))}  ` +
          `${(f.fileName ?? '-').padEnd(28)}  ` +
          `${formatBytes(f.size ?? 0).padEnd(10)}  ` +
          `${owner.padEnd(20)}  ` +
          `${c('dim', timeAgo(f.createdAt))}`,
        )
      }
      process.stderr.write(dimErr(`# ${files.length} file(s) · ${formatBytes(total)} total\n`))
      return
    }

    if (sub === 'promote') {
      const kvLiveKey = positional[1]
      if (!kvLiveKey) {
        console.error(c('red', '✗ Usage: onyx admin promote <kv_live_key>'))
        process.exit(1)
      }
      let data
      try {
        data = await request('POST', server, '/api/admin/promote', {
          body: { kvLiveKey },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ Invalid or revoked API key: ${kvLiveKey}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', '✓ User promoted to admin'))
      console.log(`  ${c('yellow', 'admin key:')}  ${data?.adminKey ?? ''}`)
      if (data?.label) console.log(`  ${c('dim', 'label:')}     ${data.label}`)
      console.log(c('dim', '  Share this onyxbase_ key with the promoted user.'))
      return
    }

    if (sub === 'admins') {
      let data
      try {
        data = await request('GET', server, '/api/admin/admins', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const admins = data?.admins ?? []
      if (admins.length === 0) {
        console.log(c('dim', '  No admin keys yet.'))
        return
      }
      console.log(
        `  ${'ADMIN KEY'.padEnd(28)}  ${'LABEL'.padEnd(20)}  ${'CREATED'.padEnd(11)}  STATUS`,
      )
      for (const a of admins) {
        let status
        if (a.revoked) status = c('red', 'revoked')
        else if (a.isBootstrap) status = c('yellow', 'bootstrap')
        else status = c('green', 'active')
        console.log(
          `  ${c('yellow', maskApiKey(a.key).padEnd(28))}  ` +
          `${(a.label ?? '-').padEnd(20)}  ` +
          `${c('dim', timeAgo(a.createdAt).padEnd(11))}  ${status}`,
        )
      }
      process.stderr.write(dimErr(`# ${admins.length} admin key(s)\n`))
      return
    }

    console.error(c('red', `✗ Unknown subcommand: onyx admin ${sub}`))
    console.error(c('dim', `  Usage: onyx admin [users|user <id>|files|promote <kv_live_key>|admins]`))
    process.exit(1)
  },

  // ─── Tables (account-scoped SQL tables) ────────────────────────────────────
  //   onyx tables                              → list all tables
  //   onyx tables list                         → (same)
  //   onyx tables create <name> --columns <spec> [--access r|w|rw]
  //   onyx tables describe <name>              → schema + sample rows
  //   onyx tables drop <name> [--yes]          → drop a table
  //   onyx tables mode <name> <r|w|rw>         → update access mode
  //   onyx tables rows <name> [--limit N]      → list rows
  //   onyx tables insert <name> --data <json>  → insert a row
  //   onyx tables update <name> --pk <json> --data <json>  → update a row
  //   onyx tables delete <name> --pk <json> [--yes]        → delete a row
  async tables(args) {
    const { positional, flags } = parseArgs(args)
    const cfg = await requireAuth()
    if (!cfg) return
    const server = ensureServer(cfg)
    const sub = positional[0] || 'list'

    // ── list (default) ──
    if (sub === 'list' || !sub) {
      let data
      try {
        data = await request('GET', server, '/v1/tables', { apiKey: cfg.apiKey })
      } catch (err) {
        return failNetwork(err, server)
      }
      const tables = data?.tables ?? []
      if (tables.length === 0) {
        console.log(c('dim', '  No tables yet. Run `onyx tables create <name> --columns "id:INTEGER:pk:ai,title:TEXT"` to add one.'))
        return
      }
      const nameW = Math.max(4, ...tables.map((t) => (t.name || '').length))
      console.log(`  ${'NAME'.padEnd(nameW)}  MODE        COLUMNS  ROWS  CREATED`)
      for (const t of tables) {
        const mode = (t.accessMode || 'rw').padEnd(11)
        const cols = String(t.columnCount ?? t.columns?.length ?? 0).padStart(7)
        const rows = String(t.rowCount ?? 0).padStart(5)
        console.log(`  ${c('cyan', (t.name || '').padEnd(nameW))}  ${mode}  ${cols}  ${rows}  ${c('dim', timeAgo(t.createdAt))}`)
      }
      process.stderr.write(dimErr(`# ${data?.count ?? tables.length} tables\n`))
      return
    }

    // ── create ──
    if (sub === 'create') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx tables create <name> --columns "id:INTEGER:pk:ai,title:TEXT:notnull,body:TEXT" [--access r|w|rw]'))
        console.error(c('dim', '  Column format: name:TYPE[:pk][:ai][:notnull][:default=VAL]  (comma-separated, or JSON array)'))
        process.exit(1)
      }
      const colsRaw = flags.columns
      if (!colsRaw || typeof colsRaw !== 'string') {
        console.error(c('red', '✗ --columns <spec> is required. Example:'))
        console.error(c('dim', `  onyx tables create notes --columns "id:INTEGER:pk:ai,title:TEXT:notnull,body:TEXT"`))
        process.exit(1)
      }
      let columns
      try {
        columns = parseColumns(colsRaw)
      } catch (e) {
        console.error(c('red', `✗ ${e.message}`))
        process.exit(1)
      }
      // --access (preferred) or --mode; accept r/w/rw short forms.
      const modeRaw = typeof flags.access === 'string' ? flags.access : (typeof flags.mode === 'string' ? flags.mode : 'rw')
      const accessMode = normalizeAccessMode(modeRaw)
      if (!accessMode) {
        console.error(c('red', `✗ Invalid access mode "${modeRaw}". Use r, w, or rw (or read, write, readwrite).`))
        process.exit(1)
      }
      let data
      try {
        data = await request('POST', server, '/v1/tables', {
          body: { name, columns, accessMode },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 400 || err.status === 404) {
          console.error(c('red', `✗ ${err.message}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Created table ${name}`))
      const t = data?.table
      if (t?.sqliteName) console.log(`  ${c('cyan', 'SQLite name')}  ${t.sqliteName}`)
      if (t?.accessMode) console.log(`  ${c('cyan', 'Access mode')}  ${t.accessMode}`)
      if (Array.isArray(t?.columns)) {
        console.log(`  ${c('cyan', 'Columns')}       ${t.columns.map((col) => col.name + ':' + col.type).join(', ')}`)
      }
      return
    }

    // ── describe (schema) ──
    if (sub === 'describe' || sub === 'schema') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx tables describe <name>'))
        process.exit(1)
      }
      let data
      try {
        data = await request('GET', server, `/v1/tables/${encodeURIComponent(name)}`, { apiKey: cfg.apiKey })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ Table "${name}" not found.`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      const t = data?.table
      if (!t) return
      console.log(`  ${c('cyan', 'Name')}         ${t.name}`)
      console.log(`  ${c('cyan', 'SQLite name')}  ${t.sqliteName || '—'}`)
      console.log(`  ${c('cyan', 'Access mode')}  ${t.accessMode || 'rw'}`)
      if (t.createdAt) console.log(`  ${c('cyan', 'Created')}     ${timeAgo(t.createdAt)}`)
      if (Array.isArray(t.columns) && t.columns.length > 0) {
        console.log()
        console.log(c('bold', '  COLUMNS'))
        const colNameW = Math.max(4, ...t.columns.map((col) => (col.name || '').length))
        console.log(`  ${'NAME'.padEnd(colNameW)}  TYPE       PK  AI  NULL  DEFAULT`)
        for (const col of t.columns) {
          const pk = col.primaryKey ? '✓' : ' '
          const ai = col.autoIncrement ? '✓' : ' '
          const nullable = col.nullable === false ? 'NO' : 'YES'
          const def = col.default != null ? String(col.default) : '—'
          console.log(`  ${c('cyan', (col.name || '').padEnd(colNameW))}  ${(col.type || '').padEnd(10)}  ${pk}   ${ai}   ${nullable.padEnd(4)}  ${c('dim', def)}`)
        }
      }
      if (Array.isArray(t.sampleRows) && t.sampleRows.length > 0) {
        console.log()
        console.log(c('bold', `  SAMPLE ROWS (${t.sampleRows.length})`))
        for (const row of t.sampleRows) {
          console.log(c('dim', `  ${JSON.stringify(row)}`))
        }
      }
      return
    }

    // ── drop (whole table) ──
    if (sub === 'drop') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx tables drop <name> [--yes]'))
        process.exit(1)
      }
      if (!flags.yes) {
        const confirmed = await confirm(`Drop table "${name}"? This permanently deletes all its data.`)
        if (!confirmed) {
          console.log(c('dim', '  Cancelled.'))
          return
        }
      }
      try {
        await request('DELETE', server, `/v1/tables/${encodeURIComponent(name)}`, { apiKey: cfg.apiKey })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ Table "${name}" not found.`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Dropped table ${name}`))
      return
    }

    // ── mode (update access mode) ──
    if (sub === 'mode') {
      const name = positional[1]
      const modeRaw = positional[2]
      if (!name || !modeRaw) {
        console.error(c('red', '✗ Usage: onyx tables mode <name> <r|w|rw>'))
        process.exit(1)
      }
      const accessMode = normalizeAccessMode(modeRaw)
      if (!accessMode) {
        console.error(c('red', `✗ Invalid mode "${modeRaw}". Use r, w, or rw.`))
        process.exit(1)
      }
      let data
      try {
        data = await request('PATCH', server, `/v1/tables/${encodeURIComponent(name)}`, {
          body: { accessMode },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 404) {
          console.error(c('red', `✗ Table "${name}" not found.`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Updated ${name} → ${data?.table?.accessMode || accessMode}`))
      return
    }

    // ── rows (list) ──
    if (sub === 'rows') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx tables rows <name> [--limit N]'))
        process.exit(1)
      }
      const limit = typeof flags.limit === 'string' ? flags.limit : '100'
      let data
      try {
        data = await request('GET', server, `/v1/tables/${encodeURIComponent(name)}/rows?limit=${encodeURIComponent(limit)}`, { apiKey: cfg.apiKey })
      } catch (err) {
        if (err.status === 403) {
          console.error(c('red', `✗ ${err.message}`))
          process.exit(1)
        }
        if (err.status === 404) {
          console.error(c('red', `✗ Table "${name}" not found.`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      const rows = data?.rows ?? []
      if (rows.length === 0) {
        console.log(c('dim', `  No rows in "${name}" yet.`))
        return
      }
      const keys = Object.keys(rows[0])
      const colW = Math.max(4, ...keys.map((k) => k.length))
      console.log(`  ${keys.map((k) => k.padEnd(colW)).join('  ')}`)
      for (const row of rows) {
        console.log(`  ${keys.map((k) => c('cyan', String(row[k] ?? '').padEnd(colW))).join('  ')}`)
      }
      process.stderr.write(dimErr(`# ${data?.count ?? rows.length} rows\n`))
      return
    }

    // ── insert ──
    if (sub === 'insert') {
      const name = positional[1]
      if (!name) {
        console.error(c('red', '✗ Usage: onyx tables insert <name> --data \'{"title":"hello"}\''))
        process.exit(1)
      }
      const dataRaw = flags.data
      if (!dataRaw || typeof dataRaw !== 'string') {
        console.error(c('red', '✗ --data <json> is required. Example:'))
        console.error(c('dim', `  onyx tables insert notes --data '{"title":"hello","done":false}'`))
        process.exit(1)
      }
      let row
      try {
        row = JSON.parse(dataRaw)
      } catch {
        console.error(c('red', '✗ --data must be valid JSON.'))
        process.exit(1)
      }
      let data
      try {
        data = await request('POST', server, `/v1/tables/${encodeURIComponent(name)}/rows`, {
          body: { row },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 400 || err.status === 403 || err.status === 404) {
          console.error(c('red', `✗ ${err.message}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Inserted row into ${name}`))
      if (data?.row) console.log(`  ${c('dim', JSON.stringify(data.row))}`)
      return
    }

    // ── update (row) — PATCH with { pk, patch } in body ──
    if (sub === 'update') {
      const name = positional[1]
      const pkRaw = flags.pk
      if (!name || !pkRaw || typeof pkRaw !== 'string') {
        console.error(c('red', '✗ Usage: onyx tables update <name> --pk \'{"id":1}\' --data \'{"done":true}\''))
        process.exit(1)
      }
      const dataRaw = flags.data
      if (!dataRaw || typeof dataRaw !== 'string') {
        console.error(c('red', '✗ --data <json> is required.'))
        process.exit(1)
      }
      let pk, patch
      try {
        pk = JSON.parse(pkRaw)
      } catch {
        console.error(c('red', '✗ --pk must be valid JSON (e.g. \'{"id":1}\').'))
        process.exit(1)
      }
      try {
        patch = JSON.parse(dataRaw)
      } catch {
        console.error(c('red', '✗ --data must be valid JSON.'))
        process.exit(1)
      }
      try {
        await request('PATCH', server, `/v1/tables/${encodeURIComponent(name)}/rows`, {
          body: { pk, patch },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 400 || err.status === 403 || err.status === 404) {
          console.error(c('red', `✗ ${err.message}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Updated row in ${name}`))
      return
    }

    // ── delete (row) — DELETE with { pk } in body ──
    if (sub === 'delete' || sub === 'rm-row' || sub === 'delete-row') {
      const name = positional[1]
      const pkRaw = flags.pk
      if (!name || !pkRaw || typeof pkRaw !== 'string') {
        console.error(c('red', '✗ Usage: onyx tables delete <name> --pk \'{"id":1}\' [--yes]'))
        process.exit(1)
      }
      let pk
      try {
        pk = JSON.parse(pkRaw)
      } catch {
        console.error(c('red', '✗ --pk must be valid JSON (e.g. \'{"id":1}\').'))
        process.exit(1)
      }
      if (!flags.yes) {
        const confirmed = await confirm(`Delete row ${JSON.stringify(pk)} from "${name}"?`)
        if (!confirmed) {
          console.log(c('dim', '  Cancelled.'))
          return
        }
      }
      try {
        await request('DELETE', server, `/v1/tables/${encodeURIComponent(name)}/rows`, {
          body: { pk },
          apiKey: cfg.apiKey,
        })
      } catch (err) {
        if (err.status === 400 || err.status === 403 || err.status === 404) {
          console.error(c('red', `✗ ${err.message}`))
          process.exit(1)
        }
        return failNetwork(err, server)
      }
      console.log(c('green', `✓ Deleted row from ${name}`))
      return
    }

    console.error(c('red', `✗ Unknown subcommand: onyx tables ${sub}`))
    console.error(c('dim', `  Usage: onyx tables [list|create <name>|describe <name>|drop <name>|mode <name> <r|w|rw>|rows <name>|insert <name>|update <name>|delete <name>]`))
    process.exit(1)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt the user for a yes/no answer on stdin.
 * Returns the trimmed, lower-cased answer (e.g. "y", "yes", "n", "").
 * Returns '' immediately when stdin is not a TTY (so scripts/CI don't hang).
 */
async function confirm(prompt) {
  if (!processStdin.isTTY) return ''
  const rl = readline.createInterface({ input: processStdin, output: processStdout })
  try {
    return (await rl.question(prompt)).trim().toLowerCase()
  } finally {
    rl.close()
  }
}

async function requireAuth() {
  const cfg = await readConfig()
  if (!cfg || !cfg.apiKey) {
    console.error(c('red', '✗ Not logged in. Run `onyx login` first.'))
    process.exit(1)
  }
  return cfg
}

function failNetwork(err, serverUrl) {
  if (err.code === 'NETWORK_ERROR' || err.message.includes('Could not reach')) {
    console.error(c('red', `✗ Could not reach Onyx Base server at ${serverUrl}`))
    console.error(c('dim', `  Hint: set ONYX_URL to point at the hosted backend, e.g. export ONYX_URL=https://your-onyx.example.com`))
    process.exit(1)
  }
  if (err.status === 401) {
    console.error(c('red', `✗ Unauthorized: ${err.message}`))
    console.error(c('dim', `  Your API key may be invalid. Run \`onyx login\` to create or recover one.`))
    process.exit(1)
  }
  console.error(c('red', `✗ ${err.message}`))
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Help banner
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = '0.1.0'

function printHelp() {
  const banner = [
    '  ╔═╗ ╔═╗ ╔╦╗ ╔═╗   ╔╦╗ ╔═╗ ╦ ╦ ╔═╗ ╦',
    '  ║ ╦ ╠═╝  ║  ║     ║ ║ ║ ║ ║ ╚═╗ ║',
    '  ╚═╝ ╩    ╩  ╚═╝   ╩ ╩ ╚═╝ ╩ ╚═╝ ╩═╝',
  ].join('\n')

  console.log(c('cyan', banner))
  console.log()
  console.log(c('dim', '  Telegram-backed key-value & file storage for developers'))
  console.log()
  console.log(c('bold', 'USAGE'))
  console.log('  onyx <command> [args] [flags]')
  console.log()
  console.log(c('bold', 'COMMANDS'))
  const rows = [
    ['login', 'Create an account & get your API key'],
    ['login --key <kv_live_…>', 'Connect an existing account (e.g. from the web)'],
    ['set <key> <value>', 'Store a value'],
    ['get <key>', 'Read a value'],
    ['delete <key>', 'Remove a value'],
    ['list', 'List all keys'],
    ['collections [create|delete <n>]', 'Manage collections'],
    ['export', 'Export the whole database as JSON'],
    ['stats', 'Show account statistics'],
    ['logs', 'Show recent audit log entries'],
    ['upload <path>', 'Upload a file (any type, up to 2 GB) → permanent link'],
    ['files', 'List stored files + their permanent links'],
    ['download <f_xxx|url>', 'Download a file by id or link'],
    ['file-link <fileId> [--force]', 'Mint a fresh Telegram direct URL for a file'],
    ['file-revoke <fileId>', 'Revoke a file\'s cached download link'],
    ['file-delete <fileId> [--yes]', 'Permanently delete a file'],
    ['share [list|create|revoke]', 'Manage public share tokens'],
    ['api-keys [list|create|revoke]', 'Manage API keys'],
    ['tables [list|create|describe|drop|mode|rows|insert|update|delete]', 'Manage account-scoped SQL tables'],
    ['telegram-config [view|set|clear]', 'View / set / clear custom Telegram config'],
    ['whoami', 'Show current credentials'],
    ['health', 'Check service + Telegram status'],
    ['admin [users|files|promote|admins]', 'Admin commands (requires onyxbase_ key)'],
    ['logout', 'Clear saved credentials'],
  ]
  for (const [name, desc] of rows) {
    console.log(`  ${c('cyan', name.padEnd(32))}${desc}`)
  }
  console.log()
  console.log(c('bold', 'FLAGS'))
  console.log(`  ${c('gray', '--key <kv_live_…>')}        Connect an existing account by API key`)
  console.log(`  ${c('gray', '--collection <name>')}     Target a non-default collection`)
  console.log(`  ${c('gray', '--name <name>')}           Name your account on login`)
  console.log(`  ${c('gray', '--email <email>')}         Attach an email to the account`)
  console.log(`  ${c('gray', '--output <file>')}         Write export to a file`)
  console.log(`  ${c('gray', '--verbose, -v')}           Show a richer table (list)`)
  console.log(`  ${c('gray', '--new')}                   Force a new account on login`)
  console.log(`  ${c('gray', '--label "note"')}          Label a file upload / share token`)
  console.log(`  ${c('gray', '--private')}               Make an uploaded file's link private`)
  console.log(`  ${c('gray', '--force')}                 Bust the cache (file-link)`)
  console.log(`  ${c('gray', '--yes')}                   Skip confirmation (file-delete)`)
  console.log(`  ${c('gray', '--limit <N>')}             Max log entries (default 20)`)
  console.log(`  ${c('gray', '--action <filter>')}       Filter logs by action`)
  console.log(`  ${c('gray', '--mode read|write|rw')}    Share token / tables access mode`)
  console.log(`  ${c('gray', '--access r|w|rw')}         Table access mode (tables create)`)
  console.log(`  ${c('gray', '--columns <spec>')}        Table columns (tables create) — "name:TYPE:pk:ai" or JSON`)
  console.log(`  ${c('gray', '--data <json>')}           Row data (tables insert/update)`)
  console.log(`  ${c('gray', '--pk <json>')}             Primary key object (tables update/delete) e.g. '{"id":1}'`)
  console.log(`  ${c('gray', '--chat-id <id>')}          Telegram chat id (telegram-config set)`)
  console.log(`  ${c('gray', '--bot-token <token>')}     Telegram bot token (telegram-config set)`)
  console.log()
  console.log(c('bold', 'ENV'))
  console.log(`  ${c('gray', 'ONYX_URL')}              Override the server URL (default ${DEFAULT_SERVER})`)
  console.log()
  console.log(c('dim', `  onyx v${VERSION}  ·  config: ~/.onyx/config.json`))
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

const ALIASES = {
  register: 'login',
  rm: 'delete',
  ls: 'list',
  keys: 'api-keys',
  col: 'collections',
  tg: 'telegram-config',
  tbl: 'tables',
}

async function main() {
  const argv = process.argv.slice(2)
  const raw = argv[0] || 'help'
  const command = ALIASES[raw] || raw

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }
  if (command === '--version' || command === '-v') {
    console.log(`onyx v${VERSION}`)
    return
  }

  const rest = argv.slice(1)
  const fn = cmd[command]
  if (!fn) {
    console.error(c('red', `✗ Unknown command: ${raw}`))
    console.error(c('dim', `  Run \`onyx --help\` to see available commands.`))
    process.exit(1)
  }
  await fn(rest)
}

main().catch((err) => {
  console.error(c('red', `✗ Unexpected error: ${err && err.message ? err.message : err}`))
  process.exit(1)
})
