'use client'

/**
 * Onyx Base — Assistant V2 tool catalog (100% client-side).
 *
 * Every capability of the dashboard is exposed as a tool the in-browser
 * agent can call. Read tools prefer the V6 Ultima cache (zero server CPU
 * when the data is fresh); mutations run through the same REST endpoints
 * the UI uses — nothing server-side knows an assistant exists.
 *
 * Write tools are ALWAYS confirmation-gated by the UI (see agent.ts) — a
 * hallucinated plan can never destroy data on its own.
 */

import type { QueryClient } from '@tanstack/react-query'
import type { RecordView } from '@/lib/api'
import { optimisticSetRecord, optimisticDeleteRecord } from '@/lib/v6/ultima'
import type { ViewKey } from '@/lib/store'

export type ToolCategory = 'read' | 'write' | 'action'

export interface ToolContext {
  /** Authorized fetch bound to the session API key. */
  api: <T = unknown>(path: string, opts?: RequestInit) => Promise<T>
  apiKey: string
  qc: QueryClient
  /** Switch the dashboard tab (client-side, zero network). */
  navigate: (view: ViewKey) => void
}

export interface ToolSpec {
  name: string
  description: string
  category: ToolCategory
  /** JSON schema for the LLM (write/action tools only — reads take no args). */
  parameters?: Record<string, unknown>
  /** Human label shown on confirmation cards. */
  label: (args: ToolArgs) => string
  /** Execute. Throws on failure (message surfaces in the chat). */
  run: (args: ToolArgs, ctx: ToolContext) => Promise<unknown>
}

export interface ToolArgs {
  collection?: string
  key?: string
  value?: unknown
  limit?: number
  name?: string
  id?: string
  mode?: string
  label?: string
  to?: string
  subject?: string
  body?: string
  credential?: string
  scopes?: string[]
  view?: string
  [k: string]: unknown
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cache-first reader: fresh V6 cache → zero server CPU; stale/absent → fetch.
 * ──────────────────────────────────────────────────────────────────────────── */

function cacheFirst<T>(qc: QueryClient, key: readonly unknown[], maxAgeMs: number, fetcher: () => Promise<T>): Promise<T> {
  const entry = qc.getQueryCache().find({ queryKey: key })
  const data = entry?.state.data as T | undefined
  if (data !== undefined && entry && Date.now() - entry.state.dataUpdatedAt < maxAgeMs) {
    return Promise.resolve(data)
  }
  return fetcher()
}

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

function normCollection(args: ToolArgs): string {
  const c = typeof args.collection === 'string' && args.collection ? args.collection : 'default'
  if (!COLLECTION_RE.test(c)) throw new Error(`Invalid collection name "${c}".`)
  return c
}

function normKey(args: ToolArgs): string {
  const k = typeof args.key === 'string' ? args.key.trim() : ''
  if (!k || k.length > 256) throw new Error('A record key (up to 256 characters) is required.')
  return k
}

/* ────────────────────────────────────────────────────────────────────────────
 * The catalog
 * ──────────────────────────────────────────────────────────────────────────── */

export const TOOLS: ToolSpec[] = [
  /* ── READ TOOLS (cache-first) ─────────────────────────────────────────── */

  {
    name: 'stats',
    description: 'Account usage statistics: record/collection/API-key counts, storage bytes, 7-day activity.',
    category: 'read',
    label: () => 'Read account stats',
    run: (_a, ctx) => cacheFirst(ctx.qc, ['stats'], 30_000, () => ctx.api('/api/dashboard/stats')),
  },
  {
    name: 'analytics',
    description: 'Analytics breakdown: records by collection, by value type, 14-day activity series, top keys.',
    category: 'read',
    label: () => 'Read analytics',
    run: (_a, ctx) => cacheFirst(ctx.qc, ['analytics'], 30_000, () => ctx.api('/api/dashboard/analytics')),
  },
  {
    name: 'records',
    description: 'List records (newest last). Optional collection filter and limit (default 20, max 50).',
    category: 'read',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Filter by collection name; omit for all' },
        limit: { type: 'integer', description: 'Max records to return (1-50, default 20)' },
      },
    },
    label: (a) => `List records${a.collection ? ` in “${a.collection}”` : ''}`,
    run: async (args, ctx) => {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
      const all = await cacheFirst<{ records?: RecordView[] }>(
        ctx.qc,
        ['records'],
        30_000,
        () => ctx.api<{ records: RecordView[] }>('/api/dashboard/records'),
      )
      const list = Array.isArray(all?.records) ? all.records : []
      const filtered = args.collection ? list.filter((r) => r.collection === args.collection) : list
      return { records: filtered.slice(-limit).reverse(), count: filtered.length }
    },
  },
  {
    name: 'get_record',
    description: 'Read one record by key (from the instant V6 cache — zero network).',
    category: 'read',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, collection: { type: 'string' } },
      required: ['key'],
    },
    label: (a) => `Read record “${a.key}”${a.collection ? ` in “${a.collection}”` : ''}`,
    run: async (args, ctx) => {
      const key = normKey(args)
      const collection = normCollection(args)
      const all = await cacheFirst(
        ctx.qc,
        ['records'],
        30_000,
        () => ctx.api<{ records: RecordView[] }>('/api/dashboard/records'),
      )
      const list = (all as { records?: RecordView[] })?.records ?? []
      const rec = list.find((r) => r.key === key && r.collection === collection)
      if (!rec) throw new Error(`Record “${key}” not found in “${collection}”.`)
      return rec
    },
  },
  {
    name: 'collections',
    description: 'List collections with record counts.',
    category: 'read',
    label: () => 'List collections',
    run: (_a, ctx) => cacheFirst(ctx.qc, ['collections'], 30_000, () => ctx.api('/api/dashboard/collections')),
  },
  {
    name: 'api_keys',
    description: 'List the account’s API keys (name, scopes, created, last used, revoked state).',
    category: 'read',
    label: () => 'List API keys',
    run: (_a, ctx) => cacheFirst(ctx.qc, ['api-keys'], 30_000, () => ctx.api('/api/dashboard/api-keys')),
  },
  {
    name: 'share_tokens',
    description: 'List public share tokens (key, mode, rate limits, revoked state).',
    category: 'read',
    label: () => 'List share tokens',
    run: (_a, ctx) => cacheFirst(ctx.qc, ['share-tokens'], 30_000, () => ctx.api('/api/dashboard/share-tokens')),
  },
  {
    name: 'files',
    description: 'List uploaded files (name, size, type, downloads). Metadata only.',
    category: 'read',
    label: () => 'List files',
    run: async (_a, ctx) => {
      const res = await cacheFirst<{ files?: Array<Record<string, unknown>> }>(
        ctx.qc, ['files'], 30_000, () => ctx.api('/api/files'),
      )
      const files = res.files ?? (res as unknown as Array<Record<string, unknown>>)
      return { files: Array.isArray(files) ? files.slice(0, 30) : [] }
    },
  },
  {
    name: 'logs',
    description: 'Recent account activity (reads, writes, auth events). Optional limit (default 20).',
    category: 'read',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    label: () => 'Read activity logs',
    run: async (args, ctx) => {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
      const res = await cacheFirst<{ logs?: unknown[] }>(ctx.qc, ['logs'], 15_000, () => ctx.api('/api/dashboard/logs?limit=50'))
      return { logs: (res.logs ?? []).slice(0, limit) }
    },
  },
  {
    name: 'email_credentials',
    description: 'List connected email credentials (name, label, last used).',
    category: 'read',
    label: () => 'List email credentials',
    run: (_a, ctx) => ctx.api('/api/credentials'),
  },
  {
    name: 'telegram_status',
    description: 'Telegram backup channel status (connected, custom bot configured).',
    category: 'read',
    label: () => 'Check Telegram status',
    run: (_a, ctx) => cacheFirst(ctx.qc, ['telegram-status'], 60_000, () => ctx.api('/api/dashboard/status')),
  },
  {
    name: 'diagnostics',
    description: 'Storage queue depth + sync diagnostics.',
    category: 'read',
    label: () => 'Read diagnostics',
    run: async (_a, ctx) => {
      const [queue, sync] = await Promise.all([
        ctx.api('/api/dashboard/diagnostics/queue').catch(() => null),
        ctx.api('/api/dashboard/diagnostics/sync').catch(() => null),
      ])
      return { queue, sync }
    },
  },

  /* ── WRITE TOOLS (confirmation-gated) ─────────────────────────────────── */

  {
    name: 'set_record',
    description: 'Create or update a record. Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { description: 'Any JSON value' }, collection: { type: 'string' } },
      required: ['key', 'value'],
    },
    label: (a) => `Set ${a.collection && a.collection !== 'default' ? `${a.collection}/` : ''}${a.key} = ${JSON.stringify(a.value)}`,
    run: async (args, ctx) => {
      const key = normKey(args)
      const collection = normCollection(args)
      if (args.value === undefined) throw new Error('`value` is required.')
      const res = await optimisticSetRecord(ctx.api, ctx.qc, { key, value: args.value, collection })
      return { saved: true, record: res.record }
    },
  },
  {
    name: 'delete_record',
    description: 'Delete a record (and its Telegram backup message). Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, collection: { type: 'string' } },
      required: ['key'],
    },
    label: (a) => `Delete record “${a.key}”${a.collection && a.collection !== 'default' ? ` from “${a.collection}”` : ''}`,
    run: async (args, ctx) => {
      const key = normKey(args)
      const collection = normCollection(args)
      await optimisticDeleteRecord(ctx.api, ctx.qc, { key, collection })
      return { deleted: true, key, collection }
    },
  },
  {
    name: 'create_collection',
    description: 'Create a new collection. Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    label: (a) => `Create collection “${a.name}”`,
    run: async (args, ctx) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!COLLECTION_RE.test(name)) throw new Error('Collection name must match [A-Za-z_][A-Za-z0-9_-]{0,63}.')
      const res = await ctx.api('/api/dashboard/collections', { method: 'POST', body: JSON.stringify({ name }) })
      ctx.qc.invalidateQueries({ queryKey: ['collections'] })
      return res
    },
  },
  {
    name: 'delete_collection',
    description: 'Delete a collection AND all its records. Destructive. Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    label: (a) => `Delete collection “${a.name}” and all its records`,
    run: async (args, ctx) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name || name === 'default') throw new Error('A non-default collection name is required.')
      const res = await ctx.api(`/api/dashboard/collections/${encodeURIComponent(name)}`, { method: 'DELETE' })
      ctx.qc.invalidateQueries({ queryKey: ['collections'] })
      ctx.qc.invalidateQueries({ queryKey: ['records'] })
      return res
    },
  },
  {
    name: 'create_api_key',
    description: 'Mint a new API key. Requires user confirmation. Options: name, scopes (read/write/delete/files/collections/export), expiresAt ISO, collectionAllowList, rateLimitPerMin.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: 'string' },
        collectionAllowList: { type: 'array', items: { type: 'string' } },
        rateLimitPerMin: { type: 'integer' },
      },
      required: ['name'],
    },
    label: (a) => `Create API key “${a.name}”${Array.isArray(a.scopes) && a.scopes.length ? ` (${a.scopes.join(', ')})` : ' (full access)'}`,
    run: async (args, ctx) => {
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'assistant-key'
      const body: Record<string, unknown> = { name }
      if (Array.isArray(args.scopes)) body.scopes = args.scopes
      if (typeof args.expiresAt === 'string') body.expiresAt = args.expiresAt
      if (Array.isArray(args.collectionAllowList)) body.collectionAllowList = args.collectionAllowList
      if (typeof args.rateLimitPerMin === 'number') body.rateLimitPerMin = args.rateLimitPerMin
      const res = await ctx.api('/api/dashboard/api-keys', { method: 'POST', body: JSON.stringify(body) })
      ctx.qc.invalidateQueries({ queryKey: ['api-keys'] })
      return res
    },
  },
  {
    name: 'revoke_api_key',
    description: 'Revoke an API key by its id (from api_keys). Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    label: (a) => `Revoke API key ${a.id}`,
    run: async (args, ctx) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) throw new Error('`id` is required (see api_keys).')
      const res = await ctx.api(`/api/dashboard/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
      ctx.qc.invalidateQueries({ queryKey: ['api-keys'] })
      return res
    },
  },
  {
    name: 'create_share_token',
    description: 'Mint a public share token for a key. Modes: read | write | readwrite. Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        collection: { type: 'string' },
        mode: { type: 'string', enum: ['read', 'write', 'readwrite'] },
        label: { type: 'string' },
        ttlMinutes: { type: 'integer' },
        rateLimitPerMin: { type: 'integer' },
      },
      required: ['key', 'mode'],
    },
    label: (a) => `Create ${a.mode ?? 'read'} share token for “${a.key}”`,
    run: async (args, ctx) => {
      const key = normKey(args)
      const mode = ['read', 'write', 'readwrite'].includes(String(args.mode)) ? String(args.mode) : 'read'
      const body: Record<string, unknown> = { key, mode }
      if (typeof args.collection === 'string') body.collection = args.collection
      if (typeof args.label === 'string') body.label = args.label
      if (typeof args.ttlMinutes === 'number') body.ttlMinutes = args.ttlMinutes
      if (typeof args.rateLimitPerMin === 'number') body.rateLimitPerMin = args.rateLimitPerMin
      const res = await ctx.api('/api/dashboard/share-tokens', { method: 'POST', body: JSON.stringify(body) })
      ctx.qc.invalidateQueries({ queryKey: ['share-tokens'] })
      return res
    },
  },
  {
    name: 'revoke_share_token',
    description: 'Revoke a public share token by id (from share_tokens). Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    label: (a) => `Revoke share token ${a.id}`,
    run: async (args, ctx) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) throw new Error('`id` is required (see share_tokens).')
      const res = await ctx.api(`/api/dashboard/share-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
      ctx.qc.invalidateQueries({ queryKey: ['share-tokens'] })
      return res
    },
  },
  {
    name: 'delete_file',
    description: 'Delete an uploaded file by its id (from files). Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    label: (a) => `Delete file ${a.id}`,
    run: async (args, ctx) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) throw new Error('`id` is required (see files).')
      const res = await ctx.api(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
      ctx.qc.invalidateQueries({ queryKey: ['files'] })
      return res
    },
  },
  {
    name: 'revoke_file_link',
    description: 'Revoke the public download link of a file by id. Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    label: (a) => `Revoke public link for file ${a.id}`,
    run: async (args, ctx) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) throw new Error('`id` is required (see files).')
      const res = await ctx.api(`/api/files/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' })
      ctx.qc.invalidateQueries({ queryKey: ['files'] })
      return res
    },
  },
  {
    name: 'send_email',
    description: 'Send an email through a connected credential (see email_credentials). Requires user confirmation.',
    category: 'write',
    parameters: {
      type: 'object',
      properties: {
        credential: { type: 'string' },
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['credential', 'to', 'subject', 'body'],
    },
    label: (a) => `Send email to ${a.to} via ${a.credential}`,
    run: async (args, ctx) => {
      const credential = typeof args.credential === 'string' ? args.credential : ''
      const to = typeof args.to === 'string' ? args.to : ''
      if (!credential || !to) throw new Error('`credential` and `to` are required.')
      const res = await ctx.api('/api/email/send', {
        method: 'POST',
        body: JSON.stringify({
          credential,
          to,
          subject: typeof args.subject === 'string' ? args.subject : '(no subject)',
          body: typeof args.body === 'string' ? args.body : '',
        }),
      })
      return res
    },
  },

  /* ── CLIENT-SIDE ACTION TOOLS (zero network) ──────────────────────────── */

  {
    name: 'navigate',
    description: 'Open a dashboard tab for the user. Views: overview, database, collections, storage, api-keys, email-automation, share, logs, analytics, playground, docs, settings, diagnostics.',
    category: 'action',
    parameters: {
      type: 'object',
      properties: { view: { type: 'string' } },
      required: ['view'],
    },
    label: (a) => `Open the ${a.view} tab`,
    run: async (args, ctx) => {
      const view = String(args.view || '').trim() as ViewKey
      const valid: ViewKey[] = [
        'assistant', 'overview', 'database', 'collections', 'storage', 'api-keys',
        'email-automation', 'share', 'logs', 'analytics', 'playground', 'docs', 'settings', 'diagnostics',
      ]
      if (!valid.includes(view)) throw new Error(`Unknown view "${view}". Valid: ${valid.join(', ')}.`)
      ctx.navigate(view)
      return { navigated: true, view }
    },
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** OpenAI-format tool descriptors for the LLM. */
export function llmToolDescriptors() {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }))
}
