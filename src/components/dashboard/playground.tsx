'use client'

import { useState, useMemo, useCallback } from 'react'
import { Terminal, Play, Copy, Loader2, RotateCcw, ChevronRight } from 'lucide-react'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from './shell'
import { toast } from 'sonner'
import { maskKey } from './shared'
import { useIsMobile } from '@/hooks/use-mobile'

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint catalog — every Onyx Base API, grouped by category.
// `authType` controls which Bearer token is injected:
//   - 'session'  → the logged-in user's kv_live_* key
//   - 'none'     → no Authorization header (public endpoints)
// ─────────────────────────────────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'DELETE'

interface EndpointDef {
  id: string
  method: Method
  path: string
  label: string
  desc?: string
  body?: string
  pathParams?: { name: string; placeholder: string }
  queryParams?: { name: string; default?: string }
  authType: 'session' | 'none'
}

interface Category {
  id: string
  label: string
  endpoints: EndpointDef[]
}

const CATEGORIES: Category[] = [
  {
    id: 'auth',
    label: 'Auth',
    endpoints: [
      {
        id: 'register',
        method: 'POST',
        path: '/api/auth/register',
        label: 'Create account',
        desc: 'Returns a kv_live_* API key. No auth required.',
        authType: 'none',
        body: '{\n  "name": "Ada",\n  "email": "ada@example.com",\n  "password": "secret123",\n  "source": "dashboard"\n}',
      },
      {
        id: 'login',
        method: 'POST',
        path: '/api/auth/login',
        label: 'Sign in (password)',
        desc: 'Email + password recovery — returns the user\'s API key.',
        authType: 'none',
        body: '{\n  "email": "ada@example.com",\n  "password": "secret123"\n}',
      },
      {
        id: 'recover',
        method: 'POST',
        path: '/api/auth/recover',
        label: 'Recover lost API key',
        desc: 'Email + password → returns the user\'s API key.',
        authType: 'none',
        body: '{\n  "email": "ada@example.com",\n  "password": "secret123"\n}',
      },
      {
        id: 'whoami',
        method: 'GET',
        path: '/api/auth/whoami',
        label: 'Who am I (session)',
        desc: 'Verify the session API key and show user info.',
        authType: 'session',
      },
    ],
  },
  {
    id: 'kv',
    label: 'Key-Value',
    endpoints: [
      {
        id: 'set',
        method: 'POST',
        path: '/v1/set',
        label: 'Set a key',
        desc: 'Upsert key/value (auto-typed: string/number/boolean/json).',
        authType: 'session',
        body: '{\n  "key": "coins",\n  "value": 500,\n  "collection": "default"\n}',
      },
      {
        id: 'get',
        method: 'GET',
        path: '/v1/get/{key}',
        label: 'Get a key',
        desc: 'Read one value (404 if missing).',
        authType: 'session',
        pathParams: { name: 'key', placeholder: 'coins' },
        queryParams: { name: 'collection', default: 'default' },
      },
      {
        id: 'delete',
        method: 'DELETE',
        path: '/v1/delete/{key}',
        label: 'Delete a key',
        desc: 'Remove key + delete its Telegram backup message.',
        authType: 'session',
        pathParams: { name: 'key', placeholder: 'coins' },
        queryParams: { name: 'collection', default: 'default' },
      },
      {
        id: 'list',
        method: 'GET',
        path: '/v1/list',
        label: 'List keys',
        desc: 'List all keys in a collection.',
        authType: 'session',
        queryParams: { name: 'collection', default: 'default' },
      },
      {
        id: 'export',
        method: 'GET',
        path: '/v1/export',
        label: 'Export database',
        desc: 'Dump {key: value} as JSON.',
        authType: 'session',
        queryParams: { name: 'collection', default: '' },
      },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    endpoints: [
      {
        id: 'files-list',
        method: 'GET',
        path: '/v1/files',
        label: 'List files',
        desc: 'List all uploaded files.',
        authType: 'session',
      },
      {
        id: 'files-link',
        method: 'GET',
        path: '/v1/files/{id}/link',
        label: 'Get file link',
        desc: 'Returns the Telegram direct URL for a file.',
        authType: 'session',
        pathParams: { name: 'id', placeholder: 'file_xxx' },
      },
      {
        id: 'files-revoke',
        method: 'POST',
        path: '/v1/files/{id}/revoke',
        label: 'Revoke file URL',
        desc: 'Invalidates any cached download token for this file.',
        authType: 'session',
        pathParams: { name: 'id', placeholder: 'file_xxx' },
      },
      {
        id: 'files-delete',
        method: 'DELETE',
        path: '/v1/files/{id}',
        label: 'Delete file',
        desc: 'Permanently delete a file + its Telegram message.',
        authType: 'session',
        pathParams: { name: 'id', placeholder: 'file_xxx' },
      },
    ],
  },
  {
    id: 'collections',
    label: 'Collections',
    endpoints: [
      {
        id: 'collections-list',
        method: 'GET',
        path: '/v1/collections',
        label: 'List collections',
        desc: 'List all collections for the current user.',
        authType: 'session',
      },
      {
        id: 'collections-delete',
        method: 'DELETE',
        path: '/v1/collections/{name}',
        label: 'Delete collection',
        desc: 'Remove a collection + all its records.',
        authType: 'session',
        pathParams: { name: 'name', placeholder: 'my_collection' },
      },
    ],
  },
  {
    id: 'share',
    label: 'Share',
    endpoints: [
      {
        id: 'share-read',
        method: 'GET',
        path: '/v1/share/{token}',
        label: 'Public read',
        desc: 'Read one scoped key via a share token (no auth).',
        authType: 'none',
        pathParams: { name: 'token', placeholder: 'st_xxx' },
      },
      {
        id: 'share-write',
        method: 'POST',
        path: '/v1/write/{token}',
        label: 'Public write',
        desc: 'Write to one scoped key via a share token. op: set|incr|append.',
        authType: 'none',
        pathParams: { name: 'token', placeholder: 'st_xxx' },
        body: '{\n  "op": "incr",\n  "value": 1\n}',
      },
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    endpoints: [
      { id: 'v1-whoami', method: 'GET', path: '/v1/whoami', label: 'Whoami (v1)', desc: 'Verify API key + show counts.', authType: 'session' },
      { id: 'health', method: 'GET', path: '/v1/health', label: 'Health', desc: 'Service health check.', authType: 'session' },
      { id: 'stats', method: 'GET', path: '/v1/stats', label: 'Stats', desc: 'Usage statistics.', authType: 'session' },
      { id: 'logs', method: 'GET', path: '/v1/logs', label: 'Logs', desc: 'Recent activity logs.', authType: 'session' },
    ],
  },
  // Admin endpoints are intentionally excluded from the public playground.
  // They are accessible only via the /admin dashboard (separate app) with
  // the onyxbase_* bootstrap key.
]

const METHOD_COLORS: Record<Method, string> = {
  GET: 'border-primary/30 bg-primary/10 text-primary',
  POST: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-400',
  DELETE: 'border-red-400/30 bg-red-400/10 text-red-400',
}

export function PlaygroundView() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const isMobile = useIsMobile()

  const [categoryId, setCategoryId] = useState('kv')
  const [endpointId, setEndpointId] = useState('set')
  const [pathParam, setPathParam] = useState('coins')
  const [queryParam, setQueryParam] = useState('default')
  const [body, setBody] = useState('{\n  "key": "coins",\n  "value": 500\n}')
  const [response, setResponse] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const category = CATEGORIES.find((c) => c.id === categoryId)!
  const endpoint = useMemo(
    () => category.endpoints.find((e) => e.id === endpointId) ?? category.endpoints[0],
    [category, endpointId],
  )

  const selectEndpoint = useCallback((catId: string, epId: string) => {
    const cat = CATEGORIES.find((c) => c.id === catId)!
    const ep = cat.endpoints.find((e) => e.id === epId)!
    setCategoryId(catId)
    setEndpointId(epId)
    setPathParam(ep.pathParams?.placeholder ?? '')
    setQueryParam(ep.queryParams?.default ?? '')
    setBody(ep.body ?? '')
    setResponse(null)
    setStatus(null)
    setDuration(null)
  }, [])

  const buildPath = useCallback(() => {
    let p = endpoint.path
    if (endpoint.pathParams) {
      p = p.replace(`{${endpoint.pathParams.name}}`, encodeURIComponent(pathParam || ''))
    }
    if (endpoint.queryParams && queryParam) {
      p += `${p.includes('?') ? '&' : '?'}${endpoint.queryParams.name}=${encodeURIComponent(queryParam)}`
    }
    return p
  }, [endpoint, pathParam, queryParam])

  const tokenForRequest = endpoint.authType === 'session' ? apiKey : null

  const buildCurl = useCallback(() => {
    const path = buildPath()
    const curl: string[] = [`curl -X ${endpoint.method} \\`, `  '${path}' \\`]
    if (tokenForRequest) {
      const masked = maskKey(apiKey ?? '')
      curl.push(`  -H 'Authorization: Bearer ${masked}' \\`)
    }
    if (endpoint.method === 'POST' && body.trim()) {
      curl.push(`  -H 'Content-Type: application/json' \\`, `  -d '${body.replace(/\n/g, ' ')}'`)
    } else {
      // strip trailing backslash from last line
      curl[curl.length - 1] = curl[curl.length - 1].replace(/ \\$/, '')
    }
    return curl.join('\n')
  }, [buildPath, endpoint, tokenForRequest, apiKey, body])

  const run = useCallback(async () => {
    setLoading(true)
    setResponse(null)
    const path = buildPath()
    const start = performance.now()
    try {
      const headers: Record<string, string> = {}
      if (tokenForRequest) headers.Authorization = `Bearer ${tokenForRequest}`
      if (endpoint.method === 'POST') headers['Content-Type'] = 'application/json'
      const res = await fetch(path, {
        method: endpoint.method,
        headers,
        body: endpoint.method === 'POST' && body.trim() ? body : undefined,
      })
      const text = await res.text()
      const elapsed = Math.round(performance.now() - start)
      setStatus(res.status)
      setDuration(elapsed)
      setResponse(pretty(text))
      if (!res.ok) toast.error(`HTTP ${res.status}`)
    } catch (err) {
      setDuration(Math.round(performance.now() - start))
      setStatus(0)
      setResponse(String(err))
      toast.error('Request failed')
    } finally {
      setLoading(false)
    }
  }, [endpoint, tokenForRequest, buildPath, body])

  const copyCurl = useCallback(async () => {
    await navigator.clipboard.writeText(buildCurl())
    toast.success('cURL copied')
  }, [buildCurl])

  const copyResponse = useCallback(async () => {
    if (!response) return
    await navigator.clipboard.writeText(response)
    toast.success('Response copied')
  }, [response])

  return (
    <div>
      <PageHeader
        title="API Playground"
        description="Try every Onyx Base API live. Auth is injected from your session key."
      />

      {/* Category tabs */}
      <Tabs value={categoryId} onValueChange={(v) => selectEndpoint(v, CATEGORIES.find((c) => c.id === v)!.endpoints[0].id)}>
        <TabsList className="mb-4 flex-wrap h-auto">
          {CATEGORIES.map((c) => (
            <TabsTrigger key={c.id} value={c.id} className="text-xs">
              {c.label}
              <span className="ml-1.5 text-[10px] opacity-50">{c.endpoints.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid lg:grid-cols-[280px_1fr] gap-4">
        {/* Endpoint list */}
        <Card className="bg-card/40 border-border/60 p-2 lg:max-h-[calc(100vh-280px)] overflow-y-auto scroll-slim">
          <div className="space-y-0.5">
            {category.endpoints.map((ep) => {
              const active = ep.id === endpointId
              return (
                <button
                  key={ep.id}
                  onClick={() => selectEndpoint(category.id, ep.id)}
                  className={`w-full text-left rounded-md px-2.5 py-2 transition-colors border ${
                    active
                      ? 'bg-primary/10 border-primary/20'
                      : 'border-transparent hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <Badge variant="outline" className={`font-mono text-[9px] px-1 py-0 ${METHOD_COLORS[ep.method]}`}>
                      {ep.method}
                    </Badge>
                    {active && <ChevronRight className="size-3 text-primary ml-auto" />}
                  </div>
                  <div className="font-mono text-[11px] text-foreground/80 truncate">{ep.path}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{ep.label}</div>
                </button>
              )
            })}
          </div>
        </Card>

        {/* Request + Response */}
        <div className="space-y-4 min-w-0">
          {/* Request builder */}
          <Card className="p-4 sm:p-5 bg-card/40 border-border/60 space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className={`font-mono text-[10px] ${METHOD_COLORS[endpoint.method]}`}>
                  {endpoint.method}
                </Badge>
                <code className="font-mono text-sm text-foreground/90 break-all">{buildPath()}</code>
              </div>
              {endpoint.desc && <p className="text-xs text-muted-foreground">{endpoint.desc}</p>}
            </div>

            {endpoint.pathParams && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Path: {`{${endpoint.pathParams.name}}`}
                </label>
                <Input
                  value={pathParam}
                  onChange={(e) => setPathParam(e.target.value)}
                  placeholder={endpoint.pathParams.placeholder}
                  className="font-mono text-sm h-9"
                />
              </div>
            )}

            {endpoint.queryParams && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Query: {endpoint.queryParams.name}
                </label>
                <Input
                  value={queryParam}
                  onChange={(e) => setQueryParam(e.target.value)}
                  placeholder="default"
                  className="font-mono text-sm h-9"
                />
              </div>
            )}

            {endpoint.method === 'POST' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Request body (JSON)
                </label>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="font-mono text-sm min-h-[120px] resize-y"
                />
              </div>
            )}

            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <Button
                onClick={run}
                disabled={loading}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Send request
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setResponse(null); setStatus(null); setDuration(null) }}
              >
                <RotateCcw className="size-3.5" /> Clear
              </Button>
            </div>

            {/* curl preview */}
            <div className="space-y-1.5 pt-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  <Terminal className="size-3" /> cURL
                </label>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={copyCurl}>
                  <Copy className="size-3" /> copy
                </Button>
              </div>
              <pre className="font-mono text-[11px] leading-relaxed text-primary/90 bg-background/60 rounded-md p-3 border border-border/40 overflow-x-auto whitespace-pre-wrap break-all max-h-40">
                {buildCurl()}
              </pre>
            </div>
          </Card>

          {/* Response */}
          <Card className="p-4 sm:p-5 bg-card/40 border-border/60 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Response
              </label>
              <div className="flex items-center gap-2">
                {status !== null && (
                  <div className="flex items-center gap-2 text-[11px] font-mono">
                    <Badge
                      variant="outline"
                      className={status >= 200 && status < 300 ? 'border-primary/30 text-primary' : 'border-red-400/30 text-red-400'}
                    >
                      {status === 0 ? 'ERR' : status}
                    </Badge>
                    {duration !== null && <span className="text-muted-foreground/70">{duration}ms</span>}
                  </div>
                )}
                {response && (
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={copyResponse}>
                    <Copy className="size-3" /> copy
                  </Button>
                )}
              </div>
            </div>
            <div className="flex-1 min-h-[200px] lg:min-h-[300px] rounded-md bg-background/60 border border-border/40 p-3 overflow-auto scroll-slim">
              {response ? (
                <pre className="font-mono text-[12px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
                  {response}
                </pre>
              ) : (
                <div className="h-full grid place-items-center text-xs text-muted-foreground/50">
                  Send a request to see the response here.
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Endpoint count footer */}
      <div className="mt-3 text-xs text-muted-foreground/70 font-mono">
        {CATEGORIES.reduce((n, c) => n + c.endpoints.length, 0)} endpoints across {CATEGORIES.length} categories
        {isMobile ? ' · mobile' : ' · desktop'}
      </div>
    </div>
  )
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
