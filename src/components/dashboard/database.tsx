'use client'

import { useState, useMemo, useCallback, Fragment, memo } from 'react'
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
import { useIsMobile } from '@/hooks/use-mobile'
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

/** How many cards to render at once on mobile before requiring "Load more". */
const MOBILE_PAGE_SIZE = 100

const SORT_OPTIONS: { value: SortKey; dir: SortDir; label: string }[] = [
  { value: 'updatedAt', dir: 'desc', label: 'Newest first' },
  { value: 'updatedAt', dir: 'asc', label: 'Oldest first' },
  { value: 'key', dir: 'asc', label: 'Key A→Z' },
  { value: 'key', dir: 'desc', label: 'Key Z→A' },
  { value: 'type', dir: 'asc', label: 'Type' },
  { value: 'collection', dir: 'asc', label: 'Collection' },
]

/**
 * DatabaseView — a real database-IDE-style table for browsing KV records.
 *
 * Layout:
 *   - Desktop (>= md): row-numbered sortable table with sticky header.
 *   - Mobile (< md):   compact card list. Each card shows the key (mono,
 *     bold), a type badge, the value (clamped to 2 lines with `break-all`
 *     so long JSON can NEVER overflow the viewport), collection + time,
 *     and copy/edit/delete actions with 44px touch targets. Tap the
 *     chevron to expand and see the full pretty-printed JSON in a <pre>.
 *
 * Performance:
 *   - Records are memoised (sort only runs when inputs change).
 *   - The inline `SortIcon` was extracted to module scope so it doesn't
 *     remount on every render.
 *   - Mobile renders at most `MOBILE_PAGE_SIZE` cards at a time; a
 *     "Load more" button reveals the next batch (no virtualisation lib).
 *   - Each card uses `content-visibility: auto` + `contain-intrinsic-size`
 *     so off-screen cards cost ~0 render time.
 */
export function DatabaseView() {
  const api = useApi()
  const qc = useQueryClient()
  const isMobile = useIsMobile()
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
  // Mobile-only pagination — desktop renders every row (it's a scrollable
  // table and desktop CPUs handle thousands of <tr> fine).
  const [mobileLimit, setMobileLimit] = useState(MOBILE_PAGE_SIZE)

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

  // Reset the mobile pager whenever the underlying list identity changes
  // (new search, new collection, new sort) — otherwise the user could be
  // stuck "Load more"-ing through stale rows.
  const recordsKey = `${activeCollection}:${search}:${sortKey}:${sortDir}:${records.length}`
  const [lastRecordsKey, setLastRecordsKey] = useState(recordsKey)
  if (recordsKey !== lastRecordsKey) {
    setLastRecordsKey(recordsKey)
    if (mobileLimit !== MOBILE_PAGE_SIZE) setMobileLimit(MOBILE_PAGE_SIZE)
  }
  const loadMore = useCallback(() => setMobileLimit((l) => l + MOBILE_PAGE_SIZE), [])

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

  // Stable callback wrappers — prevent new function identities per render
  // from blowing away React.memo on the card component.
  const copyValue = useCallback(async (r: RecordView) => {
    const text = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2)
    await navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }, [])
  const openCreate = useCallback(() => {
    setEditing(null)
    setDialogOpen(true)
  }, [])
  const openEdit = useCallback((r: RecordView) => {
    setEditing(r)
    setDialogOpen(true)
  }, [])

  // Stable callback so the memoised RecordCard doesn't re-render on every
  // parent state change.
  const confirmDeleteTarget = useCallback((r: RecordView) => {
    setDeleteTarget(r)
  }, [])

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

  const sortValue = `${sortKey}:${sortDir}`
  const onSortChange = useCallback((v: string) => {
    const [k, d] = v.split(':') as [SortKey, SortDir]
    setSortKey(k)
    setSortDir(d)
  }, [])

  return (
    <div>
      <PageHeader
        title="Database"
        description="Browse, edit, and manage your key-value records. Every write mirrors to Telegram."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => refetch()} title="Refresh" className="min-h-9">
              <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
              <span className="sm:hidden">Refresh</span>
            </Button>
            <Button variant="outline" size="sm" onClick={exportDb} className="min-h-9">
              <Download className="size-4" /> <span className="hidden sm:inline">Export</span>
            </Button>
            <Button size="sm" onClick={openCreate} className="bg-primary hover:bg-primary/90 text-primary-foreground min-h-9">
              <Plus className="size-4" /> <span className="hidden sm:inline">New record</span>
              <span className="sm:hidden">New</span>
            </Button>
          </>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
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
        {/* Mobile-only sort selector (desktop uses clickable column headers) */}
        <Select value={sortValue} onValueChange={onSortChange}>
          <SelectTrigger className="h-9 sm:hidden font-mono text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.label} value={`${o.value}:${o.dir}`}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Records — table on desktop, card list on mobile */}
      <Card className="bg-card/40 border-border/60 overflow-hidden">
        {isLoading ? (
          <div className="py-16 grid place-items-center">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : records.length === 0 ? (
          <EmptyState onCreate={openCreate} hasSearch={!!search} />
        ) : isMobile ? (
          <MobileRecordList
            records={records}
            limit={mobileLimit}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onCopy={copyValue}
            onEdit={openEdit}
            onDelete={confirmDeleteTarget}
            onLoadMore={loadMore}
          />
        ) : (
          <div className="overflow-x-auto max-h-[calc(100vh-280px)] overflow-y-auto overscroll-contain">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                <TableRow className="hover:bg-transparent border-border/40">
                  <TableHead className="w-[44px] text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">#</TableHead>
                  <TableHead className="w-[36px]" />
                  <TableHead
                    className="cursor-pointer select-none w-[24%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
                    onClick={() => toggleSort('key')}
                  >
                    <span className="inline-flex items-center gap-1">Key <SortIcon col="key" sortKey={sortKey} sortDir={sortDir} /></span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none w-[10%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
                    onClick={() => toggleSort('type')}
                  >
                    <span className="inline-flex items-center gap-1">Type <SortIcon col="type" sortKey={sortKey} sortDir={sortDir} /></span>
                  </TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Value</TableHead>
                  <TableHead
                    className="cursor-pointer select-none w-[12%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hidden md:table-cell"
                    onClick={() => toggleSort('collection')}
                  >
                    <span className="inline-flex items-center gap-1">Collection <SortIcon col="collection" sortKey={sortKey} sortDir={sortDir} /></span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none w-[11%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hidden sm:table-cell"
                    onClick={() => toggleSort('updatedAt')}
                  >
                    <span className="inline-flex items-center gap-1">Updated <SortIcon col="updatedAt" sortKey={sortKey} sortDir={sortDir} /></span>
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
                            <Button variant="ghost" size="icon" className="size-7 hover:text-red-500" onClick={() => confirmDeleteTarget(r)} title="Delete">
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
          {isMobile && mobileLimit < records.length && ` · showing ${Math.min(mobileLimit, records.length)}`}
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

/* ───────────────────────────────────────────────────────────────────────
   Mobile card list — rendered when `isMobile` is true.
   Each card is memoised so toggling expand / scroll doesn't re-render the
   whole list. `content-visibility: auto` lets the browser skip painting
   off-screen cards entirely (huge win on 500+ record collections).
   ─────────────────────────────────────────────────────────────────────── */

interface MobileRecordListProps {
  records: RecordView[]
  limit: number
  expanded: Set<string>
  onToggleExpand: (rowId: string) => void
  onCopy: (r: RecordView) => void
  onEdit: (r: RecordView) => void
  onDelete: (r: RecordView) => void
  onLoadMore: () => void
}

function MobileRecordList({
  records,
  limit,
  expanded,
  onToggleExpand,
  onCopy,
  onEdit,
  onDelete,
  onLoadMore,
}: MobileRecordListProps) {
  const visible = records.slice(0, limit)
  const remaining = records.length - visible.length
  return (
    <div className="p-3 space-y-2.5">
      {visible.map((r, idx) => (
        <RecordCard
          key={`${r.collection}-${r.key}`}
          record={r}
          index={idx}
          isExpanded={expanded.has(`${r.collection}-${r.key}`)}
          onToggleExpand={onToggleExpand}
          onCopy={onCopy}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
      {remaining > 0 && (
        <div className="pt-2 flex flex-col items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onLoadMore} className="min-h-9 w-full">
            Load {Math.min(MOBILE_PAGE_SIZE, remaining)} more
            <span className="text-muted-foreground/70 font-mono ml-1">({remaining} left)</span>
          </Button>
        </div>
      )}
    </div>
  )
}

interface RecordCardProps {
  record: RecordView
  index: number
  isExpanded: boolean
  onToggleExpand: (rowId: string) => void
  onCopy: (r: RecordView) => void
  onEdit: (r: RecordView) => void
  onDelete: (r: RecordView) => void
}

// Wrap in React.memo so a card only re-renders when its own props change
// (record identity, expansion state) — not when sibling cards toggle.
const RecordCard = memo(function RecordCard({
  record: r,
  index,
  isExpanded,
  onToggleExpand,
  onCopy,
  onEdit,
  onDelete,
}: RecordCardProps) {
  const rowId = `${r.collection}-${r.key}`
  const isLong = isLongValue(r.value, r.valueType)
  return (
    <div
      className="rounded-md border border-border/60 bg-card/60 p-3 space-y-2 active:bg-primary/[0.03] transition-colors"
      // Skip painting off-screen cards. Intrinsic size matches the collapsed
      // card height (~96px) so the scrollbar doesn't jump when scrolling in.
      style={{ contentVisibility: 'auto', containIntrinsicSize: '96px' }}
    >
      {/* Header: index · key · type · expand */}
      <div className="flex items-start gap-2">
        <span className="text-[10px] font-mono text-muted-foreground/40 tabular-nums pt-1 shrink-0 select-none">
          {String(index + 1).padStart(2, '0')}
        </span>
        <code className="font-mono text-sm font-semibold text-foreground/90 flex-1 min-w-0 break-all">
          {r.key}
        </code>
        <TypeBadge type={r.valueType} className="shrink-0 mt-0.5" />
        {isLong && (
          <button
            onClick={() => onToggleExpand(rowId)}
            className="size-9 -mr-1.5 -mt-1 grid place-items-center rounded-md text-muted-foreground hover:text-primary hover:bg-muted shrink-0"
            aria-label={isExpanded ? 'Collapse value' : 'Expand value'}
          >
            {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        )}
      </div>

      {/* Value — clamped to 2 lines with break-all so long JSON never overflows. */}
      {isExpanded ? (
        <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap break-words max-h-72 overflow-y-auto bg-background/60 border border-border/40 rounded-md p-3 scroll-slim">
          {formatExpanded(r.value, r.valueType)}
        </pre>
      ) : (
        <div className="font-mono text-sm text-foreground/80 break-all line-clamp-2">
          <CardValueText value={r.value} type={r.valueType} />
        </div>
      )}

      {/* Footer: collection · time · actions */}
      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-border/40">
        <div className="flex items-center gap-1.5 min-w-0 text-[11px] text-muted-foreground/70 font-mono">
          {r.collection === 'default' ? (
            <span className="shrink-0">default</span>
          ) : (
            <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary/80 shrink-0">
              {r.collection}
            </Badge>
          )}
          <span className="shrink-0">·</span>
          <span className="tabular-nums shrink-0">{timeAgo(r.updatedAt)}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => onCopy(r)}
            className="size-9 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="Copy value"
          >
            <Copy className="size-4" />
          </button>
          <button
            onClick={() => onEdit(r)}
            className="size-9 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="Edit record"
          >
            <Pencil className="size-4" />
          </button>
          <button
            onClick={() => onDelete(r)}
            className="size-9 grid place-items-center rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-50"
            aria-label="Delete record"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
})

/** Coloured inline value text for the mobile card (clamped by parent). */
function CardValueText({ value, type }: { value: unknown; type: string }) {
  if (type === 'string') return <>{String(value)}</>
  if (type === 'boolean') return <span className="text-amber-700">{String(value)}</span>
  if (type === 'number') return <span className="text-sky-700">{String(value)}</span>
  return <span className="text-violet-700/90">{JSON.stringify(value)}</span>
}

/** Determine if a value is "long" and deserves an expandable cell. */
function isLongValue(value: unknown, type: string): boolean {
  if (type === 'string') return String(value).length > 80
  if (type === 'object' || type === 'array') return JSON.stringify(value).length > 80
  return false
}

/** Compact one-line value cell — desktop table only. */
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

/** Full pretty-printed value for the expanded row / card. */
function formatExpanded(value: unknown, type: string): string {
  if (type === 'object' || type === 'array') return JSON.stringify(value, null, 2)
  return String(value)
}

/** Sort header icon — module-scope so it doesn't remount on every render. */
function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ArrowUpDown className="size-3 opacity-30" />
  return sortDir === 'asc' ? <ArrowUp className="size-3 text-primary" /> : <ArrowDown className="size-3 text-primary" />
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
