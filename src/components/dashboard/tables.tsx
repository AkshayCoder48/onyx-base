'use client'

import { useState, useMemo, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Table2,
  Plus,
  Trash2,
  Eye,
  Loader2,
  Database,
  Info,
  KeyRound,
  X,
  ArrowLeft,
  Pencil,
  Lock,
  Unlock,
  PenLine,
  RefreshCw,
  Copy,
} from 'lucide-react'
import { useApi } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from './shell'
import { useIsMobile } from '@/hooks/use-mobile'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

type AccessMode = 'read' | 'write' | 'readwrite'

interface ColumnDef {
  name: string
  type: string
  primary?: boolean
  autoIncrement?: boolean
  nullable?: boolean
  defaultValue?: string
}

interface UserTableMeta {
  id: string
  userId: string
  name: string
  tableName: string
  accessMode: AccessMode
  schema: ColumnDef[]
  rowCount: number
  createdAt: string
  updatedAt: string
}

interface DescribeColumn {
  name: string
  type: string
  notnull: boolean
  default: string | null
  pk: number
}

interface DescribeResult {
  name: string
  tableName: string
  accessMode: AccessMode
  columns: DescribeColumn[]
  schema: ColumnDef[]
  rowCount: number
  rows: Record<string, unknown>[]
}

type ColumnType =
  | 'TEXT'
  | 'INTEGER'
  | 'REAL'
  | 'DATETIME'
  | 'BOOLEAN'
  | 'BLOB'
  | 'NUMERIC'

const COLUMN_TYPES: ColumnType[] = [
  'TEXT',
  'INTEGER',
  'REAL',
  'DATETIME',
  'BOOLEAN',
  'BLOB',
  'NUMERIC',
]

interface ColumnBuilder {
  id: string
  name: string
  type: ColumnType
  primary: boolean
  autoIncrement: boolean
  nullable: boolean
  defaultValue: string
}

// Identifier regex used for client-side validation (mirrors the backend).
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function newColumn(): ColumnBuilder {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: '',
    type: 'TEXT',
    primary: false,
    autoIncrement: false,
    nullable: true,
    defaultValue: '',
  }
}

/**
 * Default starting column for a new table — a single `id` INTEGER PRIMARY KEY
 * AUTOINCREMENT. The user adds the rest of their columns themselves.
 *
 * Previously this returned four columns (id / title / body / created_at) which
 * matched the demo "tasks" table exactly and made it look like the "tasks"
 * table was being pre-added every time the create dialog opened.
 */
function defaultColumns(): ColumnBuilder[] {
  return [
    {
      id: Math.random().toString(36).slice(2, 10),
      name: 'id',
      type: 'INTEGER',
      primary: true,
      autoIncrement: true,
      nullable: false,
      defaultValue: '',
    },
  ]
}

/** Format a cell value for display in the grid. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Parse a string input into the right JS type for a column. */
function parseCellInput(raw: string, type: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (type === 'INTEGER') {
    const n = parseInt(trimmed, 10)
    return Number.isNaN(n) ? trimmed : n
  }
  if (type === 'REAL' || type === 'NUMERIC') {
    const n = parseFloat(trimmed)
    return Number.isNaN(n) ? trimmed : n
  }
  if (type === 'BOOLEAN') {
    return /^(true|1|yes)$/i.test(trimmed)
  }
  if (type === 'BLOB') {
    return trimmed
  }
  // TEXT / DATETIME — try JSON, fall back to string.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/** Get the PK column names from a schema. */
function pkNames(schema: ColumnDef[]): string[] {
  const pks = schema.filter((c) => c.primary)
  if (pks.length > 0) return pks.map((c) => c.name)
  return schema.length > 0 ? [schema[0].name] : []
}

const ACCESS_MODE_META: Record<
  AccessMode,
  { label: string; icon: typeof Lock; desc: string; badge: string }
> = {
  read: {
    label: 'Read-only',
    icon: Eye,
    desc: 'API can list/describe rows but cannot insert, update, or delete them.',
    badge: 'border-sky-500/40 text-sky-600 bg-sky-50',
  },
  write: {
    label: 'Write-only',
    icon: PenLine,
    desc: 'API can insert/update/delete rows but cannot list them.',
    badge: 'border-amber-500/40 text-amber-600 bg-amber-50',
  },
  readwrite: {
    label: 'Read + Write',
    icon: Unlock,
    desc: 'API can read and modify rows. Full access.',
    badge: 'border-emerald-500/40 text-emerald-600 bg-emerald-50',
  },
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TablesView() {
  const api = useApi()
  const qc = useQueryClient()
  const isMobile = useIsMobile()

  // Detail view state — when set, the grid view is shown instead of the list.
  const [openTable, setOpenTable] = useState<string | null>(null)

  // List state
  const { data, isLoading } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<{ tables: UserTableMeta[] }>('/api/dashboard/tables'),
  })
  const tables = data?.tables ?? []

  if (openTable) {
    return (
      <TableDetailView
        name={openTable}
        onBack={() => setOpenTable(null)}
      />
    )
  }

  return (
    <TableView
      tables={tables}
      isLoading={isLoading}
      isMobile={isMobile}
      onOpen={setOpenTable}
    />
  )
}

// ─── Table list view ────────────────────────────────────────────────────────

interface TableViewProps {
  tables: UserTableMeta[]
  isLoading: boolean
  isMobile: boolean
  onOpen: (name: string) => void
}

function TableView({ tables, isLoading, isMobile, onOpen }: TableViewProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [dropTarget, setDropTarget] = useState<UserTableMeta | null>(null)
  const [dropping, setDropping] = useState(false)
  const api = useApi()
  const qc = useQueryClient()

  async function confirmDrop() {
    if (!dropTarget) return
    setDropping(true)
    // Optimistic update: remove the table from the cached list IMMEDIATELY so
    // the card vanishes from the screen before the server even responds.
    // This eliminates any window where a "ghost" table card could appear
    // after the drop API call lands but before the refetch rehydrates.
    const previous = qc.getQueryData<{ tables: UserTableMeta[] }>(['tables'])
    qc.setQueryData<{ tables: UserTableMeta[] }>(['tables'], (old) => ({
      tables: (old?.tables ?? []).filter((t) => t.id !== dropTarget.id),
    }))
    try {
      await api(`/api/dashboard/tables/${encodeURIComponent(dropTarget.name)}`, {
        method: 'DELETE',
      })
      toast.success(`Dropped table "${dropTarget.name}"`)
      setDropTarget(null)
      qc.invalidateQueries({ queryKey: ['tables'] })
    } catch (err) {
      // Roll back the optimistic removal so the user can retry.
      if (previous) qc.setQueryData(['tables'], previous)
      toast.error(err instanceof Error ? err.message : 'Drop failed')
    } finally {
      setDropping(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Tables"
        description="Account-scoped SQL tables. Create, browse, and edit rows in a real database grid — fully isolated to your account."
        actions={
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="bg-primary hover:bg-primary/90 text-primary-foreground min-h-9"
          >
            <Plus className="size-4" /> <span className="hidden sm:inline">New table</span>
            <span className="sm:hidden">New</span>
          </Button>
        }
      />

      {/* Info banner */}
      <Card className="bg-primary/5 border-primary/20 p-4 mb-4 flex items-start gap-3">
        <Info className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="text-xs text-stone-700 space-y-1">
          <p>
            Tables are <strong>scoped to your account</strong> — you only see
            your own tables, never another developer&apos;s. Each table gets a
            unique SQLite name so two accounts can both own a table called{' '}
            <code className="font-mono text-primary">notes</code> without
            colliding.
          </p>
          <p>
            Choose an <strong>access mode</strong> to control what the public
            REST API (<code className="font-mono text-primary">/v1/tables</code>)
            may do with each table&apos;s rows.
          </p>
        </div>
      </Card>

      {/* Table cards */}
      {isLoading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : tables.length === 0 ? (
        <Card className="p-10 text-center border-dashed">
          <Table2 className="size-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">
            No tables yet
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            Create your first table to start storing structured rows.
          </p>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" /> Create table
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((t) => {
            const mode = ACCESS_MODE_META[t.accessMode] ?? ACCESS_MODE_META.readwrite
            const ModeIcon = mode.icon
            return (
              <Card
                key={t.id}
                className="p-4 hover:border-primary/40 transition-colors group cursor-pointer flex flex-col gap-3"
                onClick={() => onOpen(t.name)}
              >
                <div className="flex items-start gap-2">
                  <div className="size-9 rounded-md bg-primary/10 border border-primary/20 grid place-items-center shrink-0">
                    <Table2 className="size-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-semibold text-foreground truncate">
                      {t.name}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground/60 truncate">
                      {t.tableName}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border ${mode.badge}`}
                  >
                    <ModeIcon className="size-2.5" />
                    {mode.label}
                  </span>
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px] border-muted-foreground/30 text-muted-foreground"
                  >
                    {t.schema.length} cols
                  </Badge>
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px] border-muted-foreground/30 text-muted-foreground"
                  >
                    {t.rowCount} rows
                  </Badge>
                </div>

                <div className="flex items-center justify-end gap-1 pt-1 border-t border-border/40 -mx-4 -mb-4 px-4 pb-3 mt-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpen(t.name)
                    }}
                  >
                    <Eye className="size-3.5" /> Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs hover:text-red-500"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDropTarget(t)
                    }}
                  >
                    <Trash2 className="size-3.5" /> Drop
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create dialog */}
      <CreateTableDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingNames={tables.map((t) => t.name)}
      />

      {/* Drop confirm */}
      <AlertDialog
        open={!!dropTarget}
        onOpenChange={(v) => !v && setDropTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">
              Drop table &quot;{dropTarget?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the table, all of its rows, and its
              metadata. The action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDrop}
              disabled={dropping}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {dropping ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}{' '}
              Drop table
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Create dialog ──────────────────────────────────────────────────────────

interface CreateTableDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  existingNames: string[]
}

function CreateTableDialog({
  open,
  onOpenChange,
  existingNames,
}: CreateTableDialogProps) {
  const api = useApi()
  const qc = useQueryClient()
  const [tableName, setTableName] = useState('')
  const [columns, setColumns] = useState<ColumnBuilder[]>(defaultColumns())
  const [accessMode, setAccessMode] = useState<AccessMode>('readwrite')
  const [creating, setCreating] = useState(false)

  const nameValid =
    tableName.trim().length > 0 &&
    tableName.trim().length <= 64 &&
    IDENT_RE.test(tableName.trim()) &&
    !tableName.trim().toLowerCase().startsWith('usr_') &&
    !existingNames.includes(tableName.trim())

  const columnsValid =
    columns.length > 0 &&
    columns.every((c) => IDENT_RE.test(c.name)) &&
    new Set(columns.map((c) => c.name)).size === columns.length

  function resetForm() {
    setTableName('')
    setColumns(defaultColumns())
    setAccessMode('readwrite')
  }

  function updateColumn(id: string, patch: Partial<ColumnBuilder>) {
    setColumns((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        if (next.type !== 'INTEGER' || !next.primary) {
          next.autoIncrement = false
        }
        if (next.primary) next.nullable = false
        return next
      }),
    )
  }

  function addColumn() {
    setColumns((prev) => [...prev, newColumn()])
  }

  function removeColumn(id: string) {
    setColumns((prev) => prev.filter((c) => c.id !== id))
  }

  async function createTable() {
    if (!nameValid || !columnsValid) return
    setCreating(true)
    try {
      const payload = {
        name: tableName.trim(),
        accessMode,
        columns: columns.map((c) => ({
          name: c.name,
          type: c.type,
          primary: c.primary,
          autoIncrement: c.autoIncrement,
          nullable: c.nullable,
          defaultValue: c.defaultValue.trim() ? c.defaultValue.trim() : undefined,
        })),
      }
      await api<{ table: { name: string } }>('/api/dashboard/tables', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      toast.success(`Table "${tableName.trim()}" created`)
      onOpenChange(false)
      resetForm()
      qc.invalidateQueries({ queryKey: ['tables'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) resetForm()
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scroll-slim">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="size-4 text-primary" /> Create table
          </DialogTitle>
          <DialogDescription>
            Define the table name, columns, and access mode. The table is
            scoped to your account and immediately usable via the dashboard,
            REST API, and CLI.
          </DialogDescription>
        </DialogHeader>

        {/* Table name */}
        <div className="space-y-1.5">
          <Label htmlFor="table-name">Table name</Label>
          <Input
            id="table-name"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder="notes"
            className="font-mono text-sm"
            autoFocus
          />
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground/70">
              No <code className="font-mono">usr_</code> prefix needed —
              it&apos;s added automatically.
            </span>
            <span
              className={
                tableName.trim()
                  ? nameValid
                    ? 'font-mono text-emerald-600'
                    : 'font-mono text-red-500'
                  : 'font-mono text-muted-foreground/60'
              }
            >
              {tableName.trim()
                ? `usr_${tableName.trim()}_<hash>`
                : 'usr_…'}
            </span>
          </div>
          {tableName.trim() &&
            existingNames.includes(tableName.trim()) && (
              <p className="text-[11px] text-red-500">
                A table named &quot;{tableName.trim()}&quot; already exists.
              </p>
            )}
        </div>

        {/* Access mode */}
        <div className="space-y-1.5">
          <Label>Access mode</Label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(Object.keys(ACCESS_MODE_META) as AccessMode[]).map((mode) => {
              const meta = ACCESS_MODE_META[mode]
              const Icon = meta.icon
              const active = accessMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setAccessMode(mode)}
                  className={`text-left p-2.5 rounded-md border transition-colors ${
                    active
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border/60 hover:border-primary/40'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon
                      className={`size-3.5 ${
                        active ? 'text-primary' : 'text-muted-foreground'
                      }`}
                    />
                    <span className="text-xs font-semibold">{meta.label}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    {meta.desc}
                  </p>
                </button>
              )
            })}
          </div>
        </div>

        {/* Column builder */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Columns</Label>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={addColumn}
            >
              <Plus className="size-3.5" /> Add column
            </Button>
          </div>

          <div className="space-y-2">
            <div className="hidden md:grid grid-cols-[1fr_120px_80px_80px_1fr_32px] gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60 px-1">
              <span>Name</span>
              <span>Type</span>
              <span>PK / AI</span>
              <span>NOT NULL</span>
              <span>Default</span>
              <span />
            </div>

            {columns.map((c) => {
              const cNameInvalid = c.name.length > 0 && !IDENT_RE.test(c.name)
              return (
                <div
                  key={c.id}
                  className="md:grid md:grid-cols-[1fr_120px_80px_80px_1fr_32px] flex flex-col gap-2 md:items-center p-2 rounded-md border border-border/40 bg-card/30"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="md:hidden text-[10px] font-mono uppercase text-muted-foreground/60">
                      Name
                    </span>
                    <Input
                      value={c.name}
                      onChange={(e) =>
                        updateColumn(c.id, { name: e.target.value })
                      }
                      placeholder="column_name"
                      className="font-mono text-sm h-8"
                      aria-invalid={cNameInvalid}
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <span className="md:hidden text-[10px] font-mono uppercase text-muted-foreground/60">
                      Type
                    </span>
                    <Select
                      value={c.type}
                      onValueChange={(v) =>
                        updateColumn(c.id, { type: v as ColumnType })
                      }
                    >
                      <SelectTrigger className="h-8 font-mono text-xs w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COLUMN_TYPES.map((t) => (
                          <SelectItem
                            key={t}
                            value={t}
                            className="font-mono text-xs"
                          >
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2 md:justify-center">
                    <span className="md:hidden text-[10px] font-mono uppercase text-muted-foreground/60 flex-1">
                      PK / Auto-incr
                    </span>
                    <Checkbox
                      checked={c.primary}
                      onCheckedChange={(v) =>
                        updateColumn(c.id, { primary: v === true })
                      }
                      aria-label="Primary key"
                    />
                    {c.type === 'INTEGER' && c.primary && (
                      <Checkbox
                        checked={c.autoIncrement}
                        onCheckedChange={(v) =>
                          updateColumn(c.id, { autoIncrement: v === true })
                        }
                        aria-label="Auto increment"
                      />
                    )}
                  </div>

                  <div className="flex items-center gap-2 md:justify-center">
                    <span className="md:hidden text-[10px] font-mono uppercase text-muted-foreground/60 flex-1">
                      NOT NULL
                    </span>
                    <Checkbox
                      checked={!c.nullable}
                      disabled={c.primary}
                      onCheckedChange={(v) =>
                        updateColumn(c.id, { nullable: v !== true })
                      }
                      aria-label="Not null"
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <span className="md:hidden text-[10px] font-mono uppercase text-muted-foreground/60">
                      Default
                    </span>
                    <Input
                      value={c.defaultValue}
                      onChange={(e) =>
                        updateColumn(c.id, { defaultValue: e.target.value })
                      }
                      placeholder="e.g. CURRENT_TIMESTAMP"
                      className="font-mono text-xs h-8"
                      disabled={c.primary && c.autoIncrement}
                    />
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 self-end md:self-center text-muted-foreground hover:text-red-400"
                    onClick={() => removeColumn(c.id)}
                    disabled={columns.length === 1}
                    aria-label="Remove column"
                  >
                    <X className="size-3.5" />
                  </Button>

                  {cNameInvalid && (
                    <p className="text-[10px] text-red-500 md:col-span-6">
                      Invalid column name — must match{' '}
                      <code className="font-mono">^[A-Za-z_][A-Za-z0-9_]*$</code>.
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {columns.length > 0 &&
            new Set(columns.map((c) => c.name)).size !== columns.length && (
              <p className="text-[11px] text-red-500">
                Column names must be unique.
              </p>
            )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={createTable}
            disabled={creating || !nameValid || !columnsValid}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}{' '}
            Create table
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Table detail view (the real database grid) ─────────────────────────────

interface TableDetailViewProps {
  name: string
  onBack: () => void
}

function TableDetailView({ name, onBack }: TableDetailViewProps) {
  const api = useApi()
  const qc = useQueryClient()
  const isMobile = useIsMobile()
  const [rowDialog, setRowDialog] = useState<{
    open: boolean
    row: Record<string, unknown> | null
  }>({ open: false, row: null })
  const [deleteRowTarget, setDeleteRowTarget] = useState<Record<string, unknown> | null>(null)
  const [deletingRow, setDeletingRow] = useState(false)
  const [dropOpen, setDropOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [changingMode, setChangingMode] = useState(false)

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['table-detail', name],
    queryFn: () => api<{ table: DescribeResult }>(
      `/api/dashboard/tables/${encodeURIComponent(name)}`,
    ),
  })
  const table = data?.table

  const pks = useMemo(() => (table ? pkNames(table.schema) : []), [table])

  async function changeAccessMode(mode: AccessMode) {
    if (!table || mode === table.accessMode) return
    setChangingMode(true)
    try {
      await api(`/api/dashboard/tables/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ accessMode: mode }),
      })
      toast.success(`Access mode changed to ${ACCESS_MODE_META[mode].label}`)
      qc.invalidateQueries({ queryKey: ['table-detail', name] })
      qc.invalidateQueries({ queryKey: ['tables'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setChangingMode(false)
    }
  }

  async function confirmDrop() {
    setDropping(true)
    // Optimistic: remove the table from the list cache immediately so when
    // we navigate back to the list the card is already gone (no ghost
    // flicker before the refetch lands).
    const previous = qc.getQueryData<{ tables: UserTableMeta[] }>(['tables'])
    qc.setQueryData<{ tables: UserTableMeta[] }>(['tables'], (old) => ({
      tables: (old?.tables ?? []).filter((t) => t.name !== name),
    }))
    try {
      await api(`/api/dashboard/tables/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      toast.success(`Dropped table "${name}"`)
      // Drop the detail cache too so a back-button revisit refetches fresh.
      qc.removeQueries({ queryKey: ['table-detail', name] })
      qc.invalidateQueries({ queryKey: ['tables'] })
      setDropOpen(false)
      onBack()
    } catch (err) {
      // Roll back the optimistic removal so the user can retry.
      if (previous) qc.setQueryData(['tables'], previous)
      toast.error(err instanceof Error ? err.message : 'Drop failed')
    } finally {
      setDropping(false)
    }
  }

  async function confirmDeleteRow() {
    if (!deleteRowTarget || pks.length === 0) return
    const pk: Record<string, unknown> = {}
    for (const k of pks) pk[k] = deleteRowTarget[k]
    setDeletingRow(true)
    try {
      await api(`/api/dashboard/tables/${encodeURIComponent(name)}/rows`, {
        method: 'DELETE',
        body: JSON.stringify({ pk }),
      })
      toast.success('Row deleted')
      setDeleteRowTarget(null)
      qc.invalidateQueries({ queryKey: ['table-detail', name] })
      qc.invalidateQueries({ queryKey: ['tables'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeletingRow(false)
    }
  }

  async function copyTableName() {
    if (!table) return
    await navigator.clipboard.writeText(table.tableName)
    toast.success('SQL table name copied')
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-8"
        >
          <ArrowLeft className="size-4" /> Tables
        </Button>
        <span className="text-muted-foreground/40">/</span>
        <h1 className="text-lg sm:text-xl font-semibold tracking-tight font-mono">
          {name}
        </h1>
        {table && (
          <Badge
            variant="outline"
            className={`font-mono text-[10px] ${ACCESS_MODE_META[table.accessMode].badge}`}
          >
            {ACCESS_MODE_META[table.accessMode].label}
          </Badge>
        )}
      </div>

      {/* Table meta bar */}
      {table && (
        <Card className="p-3 mb-4 flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5">
            <KeyRound className="size-3 text-muted-foreground" />
            <span className="text-muted-foreground">SQL name:</span>
            <code className="font-mono text-foreground">{table.tableName}</code>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={copyTableName}
              title="Copy SQL name"
            >
              <Copy className="size-3" />
            </Button>
          </div>
          <span className="text-muted-foreground/40">·</span>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Rows:</span>
            <span className="font-mono text-foreground">{table.rowCount}</span>
          </div>
          <span className="text-muted-foreground/40">·</span>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Access mode:</span>
            <Select
              value={table.accessMode}
              onValueChange={(v) => changeAccessMode(v as AccessMode)}
              disabled={changingMode}
            >
              <SelectTrigger className="h-7 w-[140px] text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACCESS_MODE_META) as AccessMode[]).map((m) => (
                  <SelectItem key={m} value={m} className="text-xs font-mono">
                    {ACCESS_MODE_META[m].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button
              size="sm"
              className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={() => setRowDialog({ open: true, row: null })}
            >
              <Plus className="size-3.5" /> <span className="hidden sm:inline">Insert row</span>
              <span className="sm:hidden">Insert</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-red-400/30 text-red-500 hover:bg-red-50 hover:text-red-600"
              onClick={() => setDropOpen(true)}
            >
              <Trash2 className="size-3.5" /> <span className="hidden sm:inline">Drop</span>
            </Button>
          </div>
        </Card>
      )}

      {/* The real database grid */}
      {isLoading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : !table ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Table not found.
        </Card>
      ) : isMobile ? (
        // Mobile: card list of rows
        <div className="space-y-2">
          {table.rows.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No rows yet. Click <strong>Insert row</strong> to add one.
            </Card>
          ) : (
            table.rows.map((row, i) => (
              <Card key={i} className="p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    #{i + 1}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      onClick={() => setRowDialog({ open: true, row })}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6 hover:text-red-500"
                      onClick={() => setDeleteRowTarget(row)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
                {table.columns.map((col) => (
                  <div key={col.name} className="flex gap-2 text-xs">
                    <span className="font-mono text-muted-foreground/70 shrink-0">
                      {col.name}:
                    </span>
                    <span
                      className="font-mono text-foreground truncate"
                      title={formatCell(row[col.name])}
                    >
                      {formatCell(row[col.name])}
                    </span>
                  </div>
                ))}
              </Card>
            ))
          )}
        </div>
      ) : (
        <Card className="border-border/60 overflow-hidden">
          {/* Schema header strip */}
          <div className="px-3 py-2 border-b border-border/40 bg-muted/30 flex items-center gap-2 overflow-x-auto scroll-slim">
            <Database className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 shrink-0">
              Schema
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {table.schema.map((c) => (
                <span
                  key={c.name}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-card border border-border/60"
                >
                  {c.primary && (
                    <span className="text-primary font-bold" title="Primary key">
                      PK
                    </span>
                  )}
                  <span className="text-foreground font-medium">{c.name}</span>
                  <span className="text-muted-foreground/60">{c.type}</span>
                  {!c.nullable && !c.primary && (
                    <span className="text-amber-600" title="NOT NULL">
                      *
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>

          {table.rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No rows yet. Click <strong>Insert row</strong> to add one.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-auto scroll-slim">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                  <TableRow className="hover:bg-transparent border-border/40">
                    <TableHead className="w-10 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50 text-center">
                      #
                    </TableHead>
                    {table.columns.map((col) => (
                      <TableHead
                        key={col.name}
                        className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 whitespace-nowrap"
                      >
                        <div className="flex items-center gap-1">
                          {col.pk > 0 && (
                            <span className="text-primary font-bold">PK</span>
                          )}
                          <span>{col.name}</span>
                          <span className="text-muted-foreground/40 normal-case font-normal">
                            {col.type}
                          </span>
                        </div>
                      </TableHead>
                    ))}
                    <TableHead className="text-right font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50 w-20">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.rows.map((row, i) => (
                    <TableRow
                      key={i}
                      className="border-border/30 group hover:bg-muted/30"
                    >
                      <TableCell className="font-mono text-[10px] text-muted-foreground/40 text-center py-2">
                        {i + 1}
                      </TableCell>
                      {table.columns.map((col) => (
                        <TableCell
                          key={col.name}
                          className="font-mono text-xs py-2 max-w-[280px] truncate"
                          title={formatCell(row[col.name])}
                        >
                          {row[col.name] === null || row[col.name] === undefined ? (
                            <span className="text-muted-foreground/40 italic">NULL</span>
                          ) : (
                            formatCell(row[col.name])
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right py-2">
                        <div className="flex items-center justify-end gap-0.5 opacity-50 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            onClick={() => setRowDialog({ open: true, row })}
                            title="Edit row"
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 hover:text-red-500"
                            onClick={() => setDeleteRowTarget(row)}
                            title="Delete row"
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* Row insert/edit dialog */}
      <RowDialog
        open={rowDialog.open}
        onOpenChange={(v) => setRowDialog({ open: v, row: null })}
        tableName={name}
        schema={table?.schema ?? []}
        row={rowDialog.row}
      />

      {/* Row delete confirm */}
      <AlertDialog
        open={!!deleteRowTarget}
        onOpenChange={(v) => !v && setDeleteRowTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this row?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteRowTarget && (
                <code className="font-mono text-xs block mt-1 p-2 rounded bg-muted/60 break-all">
                  {JSON.stringify(
                    Object.fromEntries(
                      pks.map((k) => [k, deleteRowTarget[k]]),
                    ),
                  )}
                </code>
              )}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingRow}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteRow}
              disabled={deletingRow}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {deletingRow ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}{' '}
              Delete row
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Drop confirm */}
      <AlertDialog open={dropOpen} onOpenChange={setDropOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">
              Drop table &quot;{name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the table, all of its rows, and its
              metadata. The action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDrop}
              disabled={dropping}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {dropping ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}{' '}
              Drop table
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Row insert/edit dialog ─────────────────────────────────────────────────

interface RowDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  tableName: string
  schema: ColumnDef[]
  row: Record<string, unknown> | null
}

function RowDialog({ open, onOpenChange, tableName, schema, row }: RowDialogProps) {
  const api = useApi()
  const qc = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Reset form whenever the dialog opens or the target row changes.
  useEffect(() => {
    if (!open) return
    const next: Record<string, string> = {}
    for (const c of schema) {
      if (row && row[c.name] !== undefined && row[c.name] !== null) {
        const v = row[c.name]
        next[c.name] =
          typeof v === 'object' ? JSON.stringify(v) : String(v)
      } else {
        next[c.name] = ''
      }
    }
    setValues(next)
  }, [open, row, schema])

  const pks = useMemo(() => pkNames(schema), [schema])

  async function save() {
    setSaving(true)
    try {
      if (row) {
        // Edit: build patch (exclude PK + autoIncrement columns).
        const patch: Record<string, unknown> = {}
        for (const c of schema) {
          if (c.primary && c.autoIncrement) continue
          if (c.primary) continue
          patch[c.name] = parseCellInput(values[c.name] ?? '', c.type)
        }
        const pk: Record<string, unknown> = {}
        for (const k of pks) pk[k] = row[k]
        await api(`/api/dashboard/tables/${encodeURIComponent(tableName)}/rows`, {
          method: 'PATCH',
          body: JSON.stringify({ pk, patch }),
        })
        toast.success('Row updated')
      } else {
        // Insert: build row (exclude autoIncrement PKs that are empty).
        const newRow: Record<string, unknown> = {}
        for (const c of schema) {
          if (c.primary && c.autoIncrement) continue
          const raw = values[c.name] ?? ''
          if (raw.trim() === '') continue
          newRow[c.name] = parseCellInput(raw, c.type)
        }
        await api(`/api/dashboard/tables/${encodeURIComponent(tableName)}/rows`, {
          method: 'POST',
          body: JSON.stringify({ row: newRow }),
        })
        toast.success('Row inserted')
      }
      onOpenChange(false)
      qc.invalidateQueries({ queryKey: ['table-detail', tableName] })
      qc.invalidateQueries({ queryKey: ['tables'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scroll-slim">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {row ? (
              <>
                <Pencil className="size-4 text-primary" /> Edit row
              </>
            ) : (
              <>
                <Plus className="size-4 text-primary" /> Insert row
              </>
            )}
          </DialogTitle>
          <DialogDescription className="font-mono">
            {tableName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {schema.map((c) => {
            const isAutoPk = c.primary && c.autoIncrement
            const isPk = c.primary
            return (
              <div key={c.name} className="space-y-1">
                <Label className="text-xs flex items-center gap-1.5">
                  <span className="font-mono">{c.name}</span>
                  <span className="text-muted-foreground/50 font-mono text-[10px]">
                    {c.type}
                  </span>
                  {isPk && (
                    <Badge
                      variant="outline"
                      className="font-mono text-[9px] border-primary/40 text-primary py-0 px-1"
                    >
                      PK
                    </Badge>
                  )}
                  {!c.nullable && !isPk && (
                    <span className="text-amber-600 text-[10px]">*</span>
                  )}
                </Label>
                <Input
                  value={values[c.name] ?? ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [c.name]: e.target.value }))
                  }
                  placeholder={
                    isAutoPk
                      ? 'auto'
                      : c.defaultValue
                        ? `default: ${c.defaultValue}`
                        : c.type === 'BOOLEAN'
                          ? 'true'
                          : c.type === 'INTEGER' || c.type === 'REAL'
                            ? '0'
                            : ''
                  }
                  className="font-mono text-sm h-9"
                  disabled={isAutoPk && !row}
                />
                {isAutoPk && !row && (
                  <p className="text-[10px] text-muted-foreground/60">
                    Auto-increment — leave blank to generate.
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : row ? (
              <Pencil className="size-4" />
            ) : (
              <Plus className="size-4" />
            )}{' '}
            {row ? 'Save changes' : 'Insert row'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
