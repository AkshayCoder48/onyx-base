'use client'

import { useState, useMemo, useCallback, Fragment } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Plus,
  Download,
  Pencil,
  Trash2,
  Copy,
  Loader2,
  Database as DbIcon,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from 'lucide-react'
import { useApi, type RecordView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageHeader } from './shell'
import { TypeBadge, timeAgo } from './shared'
import { RecordDialog } from './record-dialog'
import { toast } from 'sonner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type SortKey = 'key' | 'type' | 'collection' | 'updatedAt'
type SortDir = 'asc' | 'desc'

/**
 * DatabaseView — a real database-IDE-style table for browsing KV records.
 *
 * Features:
 *   - Row numbers (like DataGrip / TablePlus)
 *   - Sticky header
 *   - Sortable columns (key / type / collection / updated)
 *   - Expandable JSON cells (click the chevron to expand long values)
 *   - Per-row hover actions (copy / edit / delete)
 *   - Collection filter dropdown + free-text search
 *   - Refresh button
 *   - Live record count + active collection indicator
 */
export function DatabaseView() {
  const api = useApi()
  const qc = useQueryClient()
  const activeCollection = useOnyxBase((s) => s.activeCollection)
  const setCollection = useOnyxBase((s) => s.setCollection)

  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RecordView | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RecordView | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const query = search ? `&q=${encodeURIComponent(search)}` : ''
  const collectionQuery =
    activeCollection !== 'all'
      ? `?collection=${activeCollection}${query ? '&' : ''}${search ? `q=${encodeURIComponent(search)}` : ''}`
      : `?${query.replace(/^&/, '')}`

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['records', activeCollection, search],
    queryFn: () => api<{ records: RecordView[] }>(`/api/dashboard/records${collectionQuery}`),
  })

  const rawRecords = useMemo(() => data?.records ?? [], [data])

  // Client-side sort — stable enough for the dashboard.
  const records = useMemo(() => {
    const sorted = [...rawRecords]
    sorted.sort((a, b) => {
      let av: string | number
      let bv: string | number
      switch (sortKey) {
        case 'key':
          av = a.key
          bv = b.key
          break
        case 'type':
          av = a.valueType
          bv = b.valueType
          break
        case 'collection':
          av = a.collection
          bv = b.collection
          break
        case 'updatedAt':
        default:
          av = new Date(a.updatedAt).getTime()
          bv = new Date(b.updatedAt).getTime()
          break
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [rawRecords, sortKey, sortDir])

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(key)
        setSortDir(key === 'updatedAt' ? 'desc' : 'asc')
      }
    },
    [sortKey],
  )

  const toggleExpand = useCallback((rowId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }, [])

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(r: RecordView) {
    setEditing(r)
    setDialogOpen(true)
  }
  async function copyValue(r: RecordView) {
    const text = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2)
    await navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }
  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api(
        `/api/dashboard/records/${encodeURIComponent(deleteTarget.key)}?collection=${encodeURIComponent(deleteTarget.collection)}`,
        { method: 'DELETE' },
      )
      toast.success(`Deleted ${deleteTarget.key}`)
      setDeleteTarget(null)
      qc.invalidateQueries({ queryKey: ['records'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['logs'] })
      qc.invalidateQueries({ queryKey: ['collections'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }
  function exportDb() {
    const url =
      activeCollection === 'all'
        ? '/api/dashboard/export'
        : `/api/dashboard/export?collection=${activeCollection}`
    window.open(url, '_blank')
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="size-3 opacity-30" />
    return sortDir === 'asc' ? <ArrowUp className="size-3 text-primary" /> : <ArrowDown className="size-3 text-primary" />
  }

  return (
    <div>
      <PageHeader
        title="Database"
        description="Browse, edit, and manage your key-value records. Every write mirrors to Telegram."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => refetch()} title="Refresh">
              <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
            </Button>
            <Button variant="outline" size="sm" onClick={exportDb}>
              <Download className="size-4" /> Export
            </Button>
            <Button size="sm" onClick={openCreate} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Plus className="size-4" /> New record
            </Button>
          </>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search keys and values…"
            className="pl-9 h-9 font-mono text-sm"
          />
        </div>
        <Select value={activeCollection} onValueChange={setCollection}>
          <SelectTrigger className="h-9 sm:w-48 font-mono text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all collections</SelectItem>
            <SelectItem value="default">default</SelectItem>
            <CollectionOptions />
          </SelectContent>
        </Select>
      </div>

      {/* Database-style table */}
      <Card className="bg-card/40 border-border/60 overflow-hidden">
        {isLoading ? (
          <div className="py-16 grid place-items-center">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : records.length === 0 ? (
          <EmptyState onCreate={openCreate} hasSearch={!!search} />
        ) : (
          <div className="overflow-x-auto max-h-[calc(100vh-280px)] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                <TableRow className="hover:bg-transparent border-border/40">
                  <TableHead className="w-[44px] text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">#</TableHead>
                  <TableHead
                    className="w-[36px]"
                  />
                  <TableHead
                    className="cursor-pointer select-none w-[24%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
                    onClick={() => toggleSort('key')}
                  >
                    <span className="inline-flex items-center gap-1">Key <SortIcon col="key" /></span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none w-[10%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
                    onClick={() => toggleSort('type')}
                  >
                    <span className="inline-flex items-center gap-1">Type <SortIcon col="type" /></span>
                  </TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Value</TableHead>
                  <TableHead
                    className="cursor-pointer select-none w-[12%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hidden md:table-cell"
                    onClick={() => toggleSort('collection')}
                  >
                    <span className="inline-flex items-center gap-1">Collection <SortIcon col="collection" /></span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none w-[11%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hidden sm:table-cell"
                    onClick={() => toggleSort('updatedAt')}
                  >
                    <span className="inline-flex items-center gap-1">Updated <SortIcon col="updatedAt" /></span>
                  </TableHead>
                  <TableHead className="w-[88px] text-right font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r, idx) => {
                  const rowId = `${r.collection}-${r.key}`
                  const isExpanded = expanded.has(rowId)
                  const isLong = isLongValue(r.value, r.valueType)
                  return (
                    <Fragment key={rowId}>
                      <TableRow className="border-border/30 group hover:bg-primary/[0.03]">
                        <TableCell className="text-center font-mono text-[11px] text-muted-foreground/40 tabular-nums py-2.5 select-none">
                          {idx + 1}
                        </TableCell>
                        <TableCell className="py-2.5">
                          {isLong && (
                            <button
                              onClick={() => toggleExpand(rowId)}
                              className="text-muted-foreground hover:text-primary transition-colors"
                              title={isExpanded ? 'Collapse' : 'Expand'}
                            >
                              {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-sm text-foreground/90 py-2.5 font-medium">{r.key}</TableCell>
                        <TableCell className="py-2.5"><TypeBadge type={r.valueType} /></TableCell>
                        <TableCell className="py-2.5 max-w-0">
                          <ValueCell value={r.value} type={r.valueType} expanded={isExpanded} />
                        </TableCell>
                        <TableCell className="hidden md:table-cell py-2.5">
                          {r.collection === 'default' ? (
                            <span className="text-[11px] text-muted-foreground/60 font-mono">default</span>
                          ) : (
                            <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary/80">{r.collection}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-[11px] text-muted-foreground/70 font-mono py-2.5 tabular-nums">{timeAgo(r.updatedAt)}</TableCell>
                        <TableCell className="text-right py-2.5">
                          <div className="flex items-center justify-end gap-0.5 opacity-50 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="size-7" onClick={() => copyValue(r)} title="Copy value">
                              <Copy className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(r)} title="Edit">
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-7 hover:text-red-500" onClick={() => setDeleteTarget(r)} title="Delete">
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="border-border/20 bg-muted/20">
                          <TableCell />
                          <TableCell />
                          <TableCell colSpan={6} className="py-3">
                            <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap break-all max-h-72 overflow-y-auto bg-background/60 border border-border/40 rounded-md p-3">
                              {formatExpanded(r.value, r.valueType)}
                            </pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground/70 font-mono">
        <span>
          {records.length} record{records.length === 1 ? '' : 's'}
          {activeCollection !== 'all' && ` · collection: ${activeCollection}`}
        </span>
        <span className="hidden sm:inline">
          sorted by {sortKey} {sortDir}
        </span>
      </div>

      <RecordDialog open={dialogOpen} onOpenChange={setDialogOpen} record={editing} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.key}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the record and deletes its Telegram backup message. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleting}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Determine if a value is "long" and deserves an expandable cell. */
function isLongValue(value: unknown, type: string): boolean {
  if (type === 'string') return String(value).length > 80
  if (type === 'object' || type === 'array') return JSON.stringify(value).length > 80
  return false
}

/** Compact one-line value cell. */
function ValueCell({ value, type, expanded }: { value: unknown; type: string; expanded: boolean }) {
  if (type === 'string') {
    const s = String(value)
    const display = expanded || s.length <= 80 ? s : s.slice(0, 80) + '…'
    return <span className="font-mono text-sm text-foreground/90">{display}</span>
  }
  if (type === 'boolean') {
    return <span className="font-mono text-sm text-amber-700">{String(value)}</span>
  }
  if (type === 'number') {
    return <span className="font-mono text-sm text-sky-700">{String(value)}</span>
  }
  const json = JSON.stringify(value)
  const display = expanded || json.length <= 80 ? json : json.slice(0, 80) + '…'
  return <span className="font-mono text-sm text-violet-700/90">{display}</span>
}

/** Full pretty-printed value for the expanded row. */
function formatExpanded(value: unknown, type: string): string {
  if (type === 'object' || type === 'array') return JSON.stringify(value, null, 2)
  return String(value)
}

function CollectionOptions() {
  const api = useApi()
  const { data } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: { id: string; name: string; records: number }[] }>('/api/dashboard/collections'),
  })
  return (
    <>
      {(data?.collections ?? [])
        .filter((c) => c.name !== 'default')
        .map((c) => (
          <SelectItem key={c.id} value={c.name} className="font-mono text-sm">
            {c.name} <span className="text-muted-foreground/60">({c.records})</span>
          </SelectItem>
        ))}
    </>
  )
}

function EmptyState({ onCreate, hasSearch }: { onCreate: () => void; hasSearch: boolean }) {
  return (
    <div className="py-16 px-6 text-center">
      <div className="size-12 rounded-xl bg-primary/10 border border-primary/20 grid place-items-center mx-auto mb-4">
        <DbIcon className="size-5 text-primary" />
      </div>
      <h3 className="text-sm font-medium mb-1">{hasSearch ? 'No matches' : 'No records yet'}</h3>
      <p className="text-xs text-muted-foreground mb-4">
        {hasSearch ? 'Try a different search term.' : 'Create your first key-value record to get started.'}
      </p>
      {!hasSearch && (
        <Button size="sm" onClick={onCreate} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <Plus className="size-4" /> New record
        </Button>
      )}
    </div>
  )
}
