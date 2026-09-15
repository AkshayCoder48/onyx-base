/**
 * OnyxBase V5 — V4 → V5 migration (docs/v5-contract.md §20).
 *
 * Remote HTTP mode (THE path): pulls every collection from a running V4
 * instance via its paginated /v1/export endpoint and upserts the records
 * into v5_kv under the master owner. Idempotent — safe to re-run.
 *
 * Dual-read safety: until RGE Hub switches its ONYXBASE_V5_URL on, V4
 * remains authoritative; this import is a snapshot + ongoing backfill.
 * Rollback = simply unset ONYXBASE_V5_URL on the client side.
 */

import { v5db, nowMs, num } from './db'

export interface MigrateSource {
  baseUrl: string
  apiKey: string
}

export interface MigrateReport {
  collections: Array<{ collection: string; imported: number; skipped: number }>
  totalImported: number
  dryRun: boolean
}

const PRIVATE_IP = /(^127\.)|(^10\.)|(^172\.(1[6-9]|2\d|3[01])\.)|(^192\.168\.)|(^localhost)|(^0\.0\.0\.0)/

function assertSourceUrl(baseUrl: string): void {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    throw Object.assign(new Error('source.baseUrl must be a valid URL.'), { code: 'VALIDATION_ERROR' })
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw Object.assign(new Error('source.baseUrl must be http(s).'), { code: 'VALIDATION_ERROR' })
  }
  const allowPrivate = process.env.V5_MIGRATE_ALLOW_PRIVATE === 'true'
  if (!allowPrivate && PRIVATE_IP.test(u.hostname)) {
    throw Object.assign(
      new Error('Refusing to migrate from a private/localhost host (set V5_MIGRATE_ALLOW_PRIVATE=true to override).'),
      { code: 'VALIDATION_ERROR' }
    )
  }
}

async function fetchJson(url: string, apiKey: string, timeoutMs = 30_000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: controller.signal })
    if (!res.ok) throw new Error(`V4 export HTTP ${res.status} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** List collections on the V4 instance via GET /v1/collections. */
async function listV4Collections(src: MigrateSource): Promise<string[]> {
  const data = (await fetchJson(`${src.baseUrl.replace(/\/+$/, '')}/v1/collections`, src.apiKey)) as {
    collections?: Array<{ name?: string }>
  }
  const names = (data.collections ?? [])
    .map((c) => (typeof c?.name === 'string' ? c.name : ''))
    .filter((n) => n.length > 0)
  if (names.length > 0) return names
  // Fallback: derive from the default-collection key index (legacy flat keys).
  const listData = (await fetchJson(`${src.baseUrl.replace(/\/+$/, '')}/v1/list?limit=1000`, src.apiKey)) as {
    keys?: string[]
  }
  const collections = new Set<string>()
  for (const k of listData.keys ?? []) {
    const i = k.indexOf('.')
    if (i > 0) collections.add(k.slice(0, i))
  }
  return [...collections]
}

export async function migrateFromV4(
  owner: string,
  opts: { source?: MigrateSource; collections?: string[]; dryRun?: boolean }
): Promise<MigrateReport> {
  const src = opts.source
  if (!src || !src.baseUrl || !src.apiKey) {
    throw Object.assign(new Error('source {baseUrl, apiKey} is required (remote V4 export mode).'), {
      code: 'VALIDATION_ERROR',
    })
  }
  assertSourceUrl(src.baseUrl)
  const base = src.baseUrl.replace(/\/+$/, '')
  const collections = opts.collections?.length ? opts.collections : await listV4Collections({ baseUrl: base, apiKey: src.apiKey })

  const report: MigrateReport = { collections: [], totalImported: 0, dryRun: Boolean(opts.dryRun) }
  const db = await v5db()

  for (const collection of collections) {
    let offset = 0
    let imported = 0
    let skipped = 0
    for (;;) {
      const page = (await fetchJson(`${base}/v1/export?collection=${encodeURIComponent(collection)}&limit=1000&offset=${offset}`, src.apiKey)) as {
        data?: Record<string, unknown>
      }
      const entries = Object.entries(page.data ?? {}).filter(([k]) => k !== '__pagination')
      if (entries.length === 0) break
      if (!opts.dryRun) {
        const now = nowMs()
        await db.batch(
          entries.map(([rawKey, value]) => {
            // V4 export keys arrive PREFIXED with "collection." while V4/V5
            // set/get use BARE keys — strip so lookups hit after import.
            const key = rawKey.startsWith(`${collection}.`) ? rawKey.slice(collection.length + 1) : rawKey
            const json = JSON.stringify(value ?? null)
            return {
              sql: `INSERT INTO v5_kv (owner, collection, key, value, size, created_at, updated_at, deleted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT(owner, collection, key) DO UPDATE SET
                      value = excluded.value, size = excluded.size, updated_at = excluded.updated_at, deleted_at = NULL`,
              args: [owner, collection, key, json, Buffer.byteLength(json, 'utf8'), now, now],
            }
          }),
          'write'
        )
      }
      imported += entries.length
      offset += entries.length
      const meta = (page.data ?? {}).__pagination as { hasMore?: boolean } | undefined
      if (!meta?.hasMore) break
    }
    if (!opts.dryRun && imported > 0) {
      await db.execute({
        sql: `INSERT INTO v5_counters (owner, name, value, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(owner, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [owner, `kv:${collection}:live`, imported, nowMs()],
      })
    }
    report.collections.push({ collection, imported, skipped })
    report.totalImported += imported
  }
  return report
}

export { num }
