'use client'

import { useState } from 'react'
import { Terminal, Play, Copy, Loader2, RotateCcw } from 'lucide-react'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { toast } from 'sonner'
import { maskKey } from './shared'

interface EndpointDef {
  id: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  label: string
  body?: string
  pathParams?: { name: string; placeholder: string }
  queryParams?: { name: string; default?: string }
}

const ENDPOINTS: EndpointDef[] = [
  { id: 'set', method: 'POST', path: '/v1/set', label: 'Set a key', body: '{\n  "key": "coins",\n  "value": 500,\n  "collection": "default"\n}' },
  { id: 'get', method: 'GET', path: '/v1/get/{key}', label: 'Get a key', pathParams: { name: 'key', placeholder: 'coins' }, queryParams: { name: 'collection', default: 'default' } },
  { id: 'list', method: 'GET', path: '/v1/list', label: 'List keys', queryParams: { name: 'collection', default: '' } },
  { id: 'delete', method: 'DELETE', path: '/v1/delete/{key}', label: 'Delete a key', pathParams: { name: 'key', placeholder: 'coins' }, queryParams: { name: 'collection', default: 'default' } },
  { id: 'export', method: 'GET', path: '/v1/export', label: 'Export database', queryParams: { name: 'collection', default: '' } },
  { id: 'health', method: 'GET', path: '/v1/health', label: 'Service health' },
]

const METHOD_COLORS: Record<string, string> = {
  GET: 'border-primary/30 bg-primary/10 text-primary',
  POST: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  DELETE: 'border-red-400/30 bg-red-400/10 text-red-300',
}

export function PlaygroundView() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const [endpointId, setEndpointId] = useState('set')
  const [pathParam, setPathParam] = useState('coins')
  const [queryParam, setQueryParam] = useState('default')
  const [body, setBody] = useState('{\n  "key": "coins",\n  "value": 500\n}')
  const [response, setResponse] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const endpoint = ENDPOINTS.find((e) => e.id === endpointId)!

  function selectEndpoint(id: string) {
    const e = ENDPOINTS.find((x) => x.id === id)!
    setEndpointId(id)
    setPathParam(e.pathParams?.placeholder ?? '')
    setQueryParam(e.queryParams?.default ?? '')
    setBody(e.body ?? '')
    setResponse(null)
    setStatus(null)
    setDuration(null)
  }

  function buildPath() {
    let p = endpoint.path
    if (endpoint.pathParams) p = p.replace(`{${endpoint.pathParams.name}}`, encodeURIComponent(pathParam || ''))
    if (endpoint.queryParams && queryParam) p += `${p.includes('?') ? '&' : '?'}${endpoint.queryParams.name}=${encodeURIComponent(queryParam)}`
    return p
  }

  function buildCurl() {
    const path = buildPath()
    const curl = [`curl -X ${endpoint.method} \\`, `  '${path}' \\`, `  -H 'Authorization: Bearer ${apiKey ?? 'kv_live_xxx'}'`]
    if (endpoint.method === 'POST' && body.trim()) {
      curl.push(`  -H 'Content-Type: application/json' \\`, `  -d '${body.replace(/\n/g, ' ')}'`)
    }
    return curl.join('\n')
  }

  async function run() {
    setLoading(true)
    setResponse(null)
    const path = buildPath()
    const start = performance.now()
    try {
      const res = await fetch(path, {
        method: endpoint.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(endpoint.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
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
  }

  async function copyCurl() {
    await navigator.clipboard.writeText(buildCurl())
    toast.success('cURL copied')
  }

  return (
    <div>
      <PageHeader
        title="API Playground"
        description="Try the REST API live. Auth is injected from your session."
      />

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Request builder */}
        <Card className="p-5 bg-card/40 border-border/60 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Endpoint</label>
            <Select value={endpointId} onValueChange={selectEndpoint}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENDPOINTS.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className={`font-mono text-[9px] ${METHOD_COLORS[e.method]}`}>{e.method}</Badge>
                      <span className="font-mono text-xs">{e.path}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {endpoint.pathParams && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Path: {`{${endpoint.pathParams.name}}`}</label>
              <Input value={pathParam} onChange={(e) => setPathParam(e.target.value)} placeholder={endpoint.pathParams.placeholder} className="font-mono text-sm h-9" />
            </div>
          )}

          {endpoint.queryParams && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Query: {endpoint.queryParams.name}</label>
              <Input value={queryParam} onChange={(e) => setQueryParam(e.target.value)} placeholder="default" className="font-mono text-sm h-9" />
            </div>
          )}

          {endpoint.method === 'POST' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Request body (JSON)</label>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-sm min-h-[140px] resize-y" />
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={run} disabled={loading} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Send request
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setResponse(null); setStatus(null); setDuration(null) }}>
              <RotateCcw className="size-3.5" /> Clear
            </Button>
          </div>

          {/* curl preview */}
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Terminal className="size-3" /> cURL
              </label>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={copyCurl}><Copy className="size-3" /> copy</Button>
            </div>
            <pre className="font-mono text-[11px] leading-relaxed text-primary/90 bg-background/60 rounded-md p-3 border border-border/40 overflow-x-auto whitespace-pre-wrap break-all">
              {buildCurl().replace(/Bearer kv_live_[a-f0-9]+/, `Bearer ${maskKey(apiKey ?? '')}`)}
            </pre>
          </div>
        </Card>

        {/* Response */}
        <Card className="p-5 bg-card/40 border-border/60 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Response</label>
            {status !== null && (
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <Badge variant="outline" className={status >= 200 && status < 300 ? 'border-primary/30 text-primary' : 'border-red-400/30 text-red-300'}>
                  {status === 0 ? 'ERR' : status}
                </Badge>
                {duration !== null && <span className="text-muted-foreground/70">{duration}ms</span>}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-[300px] rounded-md bg-background/60 border border-border/40 p-3 overflow-auto scroll-slim">
            {response ? (
              <pre className="font-mono text-[12px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">{response}</pre>
            ) : (
              <div className="h-full grid place-items-center text-xs text-muted-foreground/50">
                Send a request to see the response here.
              </div>
            )}
          </div>
        </Card>
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
