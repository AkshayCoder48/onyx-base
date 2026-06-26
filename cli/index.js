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
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

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
    ['export', 'Export the whole database as JSON'],
    ['upload <path>', 'Upload a file (any type, up to 2 GB) → permanent link'],
    ['files', 'List stored files + their permanent links'],
    ['download <f_xxx|url>', 'Download a file by id or link'],
    ['whoami', 'Show current credentials'],
    ['health', 'Check service + Telegram status'],
    ['logout', 'Clear saved credentials'],
  ]
  for (const [name, desc] of rows) {
    console.log(`  ${c('cyan', name.padEnd(28))}${desc}`)
  }
  console.log()
  console.log(c('bold', 'FLAGS'))
  console.log(`  ${c('gray', '--key <kv_live_…>')}      Connect an existing account by API key`)
  console.log(`  ${c('gray', '--collection <name>')}   Target a non-default collection`)
  console.log(`  ${c('gray', '--name <name>')}         Name your account on login`)
  console.log(`  ${c('gray', '--email <email>')}       Attach an email to the account`)
  console.log(`  ${c('gray', '--output <file>')}       Write export to a file`)
  console.log(`  ${c('gray', '--verbose, -v')}         Show a richer table (list)`)
  console.log(`  ${c('gray', '--new')}                 Force a new account on login`)
  console.log(`  ${c('gray', '--label "note"')}        Label a file upload`)
  console.log(`  ${c('gray', '--private')}             Make an uploaded file's link private`)
  console.log()
  console.log(c('bold', 'ENV'))
  console.log(`  ${c('gray', 'ONYX_URL')}            Override the server URL (default ${DEFAULT_SERVER})`)
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
