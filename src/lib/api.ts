'use client'

import { useOnyxBase } from '@/lib/store'

/** Typed fetch wrapper that auto-injects the Bearer API key. */
export async function api<T = unknown>(
  path: string,
  opts: RequestInit & { apiKey?: string } = {},
): Promise<T> {
  const apiKey = opts.apiKey ?? null
  const headers = new Headers(opts.headers)
  if (opts.body) headers.set('Content-Type', 'application/json')
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)

  const res = await fetch(path, { ...opts, headers })
  const text = await res.text()
  const data = text ? safeJson(text) : null

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && String((data as Record<string, unknown>).error)) ||
      `Request failed (${res.status})`
    throw new Error(message)
  }
  return (data as { ok?: boolean } & T) ?? ({} as T)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Convenience hook returning an authorized `api()` caller bound to the session. */
export function useApi() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  return <T = unknown>(path: string, opts: RequestInit = {}) => api<T>(path, { ...opts, apiKey: apiKey ?? undefined })
}

/* ----- typed response shapes ----- */

export interface RecordView {
  key: string
  value: unknown
  valueType: string
  collection: string
  updatedAt: string
  createdAt: string
}

export interface ApiKeyView {
  id: string
  name: string
  key: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
  /** v3: empty = full access (backward compat). */
  scopes: import('@/lib/data-store').ApiKeyScope[]
  /** v3: ISO timestamp, null = never expires. */
  expiresAt: string | null
  /** v3: empty = all collections. */
  collectionAllowList: string[]
  /** v3: empty = all tables. */
  tableAllowList: string[]
  /** v3: null/0 = unlimited. */
  rateLimitPerMin: number | null
  /** v3: null/0 = unlimited. */
  rateLimitMbPerDay: number | null
}

export interface CollectionView {
  id: string
  name: string
  records: number
  createdAt: string
}

export interface FileView {
  id: string
  fileId: string
  fileName: string
  mimeType: string
  size: number
  /** Which Telegram backend holds the file — 'server' (operator's env bot) or 'custom' (user's own bot). */
  storageMode: 'server' | 'custom'
  label: string | null
  isPublic: boolean
  downloads: number
  /** Epoch-ms of the most recent "Revoke link" action (null if never revoked). */
  linkRevokedAt: number | null
  createdAt: string
  updatedAt: string
  downloadUrl: string
}

export interface ShareTokenView {
  id: string
  token: string
  collection: string
  key: string
  mode: 'read' | 'write' | 'readwrite'
  label: string | null
  expiresAt: string | null
  rateLimitPerMin: number | null
  allowedOps: ('set' | 'incr' | 'append')[]
  maxValueLength: number | null
  incrMin: number | null
  incrMax: number | null
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
  readUrl: string
  writeUrl: string
}

export interface LogView {
  id: string
  action: string
  key: string | null
  detail: string | null
  source: string
  ip: string | null
  createdAt: string
}

export interface StatsView {
  records: number
  collections: number
  apiKeys: number
  logs: number
  storageBytes: number
  files?: number
  fileBytes?: number
  activityByDay: Record<string, number>
  activityByAction: Record<string, number>
}

export interface AnalyticsView {
  byCollection: { name: string; records: number }[]
  byType: { type: string; count: number }[]
  series: { day: string; count: number }[]
  topKeys: { key: string; count: number }[]
  totalEvents: number
}
