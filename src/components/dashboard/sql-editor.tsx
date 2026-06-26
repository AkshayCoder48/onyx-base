'use client'

import { useState, useCallback } from 'react'
import { Play, Loader2, Database, Trash2, Clock } from 'lucide-react'
import { useApi } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { toast } from 'sonner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface SqlResult {
  rows: Record<string, unknown>[]
  count: number
  truncated: boolean
  virtualTables: string[]
}

/** Pre-built query templates — click to load into the editor. */
const SNIPPETS: { label: string; sql: string; desc: string }[] = [
  {
    label: 'Recent records',
    desc: 'Last 20 records by updatedAt',
    sql: 'SELECT key, value, valueType, updatedAt\nFROM records\nORDER BY updatedAt DESC\nLIMIT 20',
  },
  {
    label: 'Records by type',
    desc: 'Count records grouped by valueType',
    sql: 'SELECT valueType, COUNT(*) as count\nFROM records\nGROUP BY valueType\nORDER BY count DESC',
  },
  {
    label: 'Collections + counts',
    desc: 'How many records per collection',
    sql: 'SELECT c.name, COUNT(r.id) as records\nFROM collections c\nLEFT JOIN records r ON r.collectionId = c.id\nGROUP BY c.name\nORDER BY records DESC',
  },
  {
    label: 'Recent logs',
    desc: 'Last 30 activity log entries',
    sql: 'SELECT action, key, source, createdAt\nFROM logs\nORDER BY createdAt DESC\nLIMIT 30',
  },
  {
    label: 'API keys',
    desc: 'List your API keys (masked)',
    sql: 'SELECT name, key, revoked, lastUsedAt, createdAt\nFROM api_keys\nORDER BY createdAt DESC',
  },
  {
    label: 'My profile',
    desc: 'Your user record',
    sql: 'SELECT userId, name, email, plan, createdAt\nFROM users',
  },
]

/** Recently-run queries (localStorage, max 10). */
function loadHistory(): string[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem('onyx_sql_history') || '[]')
  } catch {
    return []
  }
}
function saveHistory(q: string) {
  if (typeof window === 'undefined') return
  const prev = loadHistory().filter((x) => x !== q)
  localStorage.setItem('onyx_sql_history', JSON.stringify([q, ...prev].slice(0, 10)))
}

export function SqlEditorView() {
  const api = useApi()
  const [sql, setSql] = useState(SNIPPETS[0].sql)
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  const [history, setHistory] = useState<string[]>(() => loadHistory())

  const run = useCallback(async () => {
    if (!sql.trim()) {
      toast.error('Enter a query first')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    const start = performance.now()
    try {
      const res = await api<SqlResult>('/api/dashboard/sql', {
        method: 'POST',
        body: JSON.stringify({ sql }),
      })
      setResult(res)
      setDuration(Math.round(performance.now() - start))
      saveHistory(sql.trim())
      setHistory(loadHistory())
      toast.success(`${res.count} row${res.count === 1 ? '' : 's'} returned`)
    } catch (err) {
      setDuration(Math.round(performance.now() - start))
      setError(err instanceof Error ? err.message : 'Query failed')
      toast.error(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setLoading(false)
    }
  }, [api, sql])

  const columns = result?.rows?.[0] ? Object.keys(result.rows[0]) : []

  return (
    <div>
      <PageHeader
        title="SQL Editor"
        description="Run read-only SELECT queries against your data. Virtual tables are pre-filtered to your account — you can only see your own rows."
      />

      {/* Virtual tables reference */}
      <Card className="p-3 mb-4 bg-card/40 border-border/60">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted-foreground uppercase tracking-wide">Virtual tables:</span>
          {['records', 'collections', 'api_keys', 'logs', 'users'].map((t) => (
            <Badge key={t} variant="outline" className="font-mono text-[10px] border-primary/30 text-primary/80">
              {t}
            </Badge>
          ))}
          <span className="text-muted-foreground/60 ml-2">· capped at 1000 rows · keys masked</span>
        </div>
      </Card>

      <div className="grid lg:grid-cols-[1fr_200px] gap-4">
        {/* Editor + results */}
        <div className="space-y-4 min-w-0">
          {/* SQL editor */}
          <Card className="bg-card/40 border-border/60 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground/70">Query</span>
              <div className="flex items-center gap-2">
                {duration !== null && (
                  <span className="text-[11px] font-mono text-muted-foreground/60">{duration}ms</span>
                )}
                <Button size="sm" onClick={run} disabled={loading} className="bg-primary hover:bg-primary/90 text-primary-foreground h-7">
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run
                </Button>
              </div>
            </div>
            <Textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              className="font-mono text-sm min-h-[140px] resize-y border-0 rounded-none focus-visible:ring-0"
              placeholder="SELECT key, value FROM records WHERE valueType = 'string' ORDER BY updatedAt DESC LIMIT 20"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  run()
                }
              }}
            />
            <div className="px-3 py-1.5 border-t border-border/40 text-[10px] text-muted-foreground/50 font-mono">
              ⌘/Ctrl + Enter to run
            </div>
          </Card>

          {/* Error */}
          {error && (
            <Card className="p-4 bg-red-500/5 border-red-500/30">
              <pre className="font-mono text-xs text-red-500 whitespace-pre-wrap break-words">{error}</pre>
            </Card>
          )}

          {/* Results */}
          {result && (
            <Card className="bg-card/40 border-border/60 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
                <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground/70">
                  Results · {result.count} row{result.count === 1 ? '' : 's'}
                </span>
                {result.truncated && (
                  <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">
                    truncated at 1000
                  </Badge>
                )}
              </div>
              <div className="overflow-x-auto max-h-[calc(100vh-420px)] overflow-y-auto scroll-slim">
                {result.rows.length === 0 ? (
                  <div className="py-12 text-center text-xs text-muted-foreground/50">No rows returned.</div>
                ) : (
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                      <TableRow className="hover:bg-transparent border-border/40">
                        {columns.map((col) => (
                          <TableHead key={col} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 whitespace-nowrap">
                            {col}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.rows.map((row, i) => (
                        <TableRow key={i} className="border-border/30">
                          {columns.map((col) => (
                            <TableCell key={col} className="font-mono text-xs py-2 max-w-[300px] truncate" title={String(row[col] ?? '')}>
                              {formatCell(row[col])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* Sidebar: snippets + history */}
        <div className="space-y-4">
          {/* Snippets */}
          <Card className="bg-card/40 border-border/60 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-2 flex items-center gap-1.5">
              <Database className="size-3" /> Snippets
            </div>
            <div className="space-y-1">
              {SNIPPETS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => { setSql(s.sql); setError(null); setResult(null) }}
                  className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors border border-transparent hover:border-border/40"
                >
                  <div className="text-xs font-medium text-foreground/90">{s.label}</div>
                  <div className="text-[10px] text-muted-foreground/60">{s.desc}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* History */}
          {history.length > 0 && (
            <Card className="bg-card/40 border-border/60 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1.5">
                  <Clock className="size-3" /> History
                </div>
                <button
                  onClick={() => { localStorage.removeItem('onyx_sql_history'); setHistory([]) }}
                  className="text-[10px] text-muted-foreground/50 hover:text-red-500 transition-colors"
                  title="Clear history"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
              <div className="space-y-1">
                {history.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => { setSql(q); setError(null); setResult(null) }}
                    className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors border border-transparent hover:border-border/40"
                  >
                    <div className="font-mono text-[10px] text-muted-foreground/80 line-clamp-2 break-all">{q.replace(/\n/g, ' ')}</div>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/** Format a cell value for display in the results table. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
