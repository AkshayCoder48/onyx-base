'use client'

import { useState, useMemo } from 'react'
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface UserTable {
  name: string
  type: 'user'
  sql: string
}

interface SystemTable {
  name: string
  type: 'virtual'
}

interface TablesListResponse {
  systemTables: SystemTable[]
  userTables: UserTable[]
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

interface DescribeColumn {
  name: string
  type: string
  notnull: boolean
  default: string | null
  pk: number
}

interface DescribeResponse {
  name: string
  columns: DescribeColumn[]
  rowCount: number
  sampleRows: Record<string, unknown>[]
  isVirtual: boolean
  message?: string
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
    {
      id: Math.random().toString(36).slice(2, 10),
      name: 'title',
      type: 'TEXT',
      primary: false,
      autoIncrement: false,
      nullable: false,
      defaultValue: '',
    },
    {
      id: Math.random().toString(36).slice(2, 10),
      name: 'body',
      type: 'TEXT',
      primary: false,
      autoIncrement: false,
      nullable: true,
      defaultValue: '',
    },
    {
      id: Math.random().toString(36).slice(2, 10),
      name: 'created_at',
      type: 'DATETIME',
      primary: false,
      autoIncrement: false,
      nullable: true,
      defaultValue: 'CURRENT_TIMESTAMP',
    },
  ]
}

/** Format a sample cell for display. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TablesView() {
  const api = useApi()
  const qc = useQueryClient()
  const isMobile = useIsMobile()

  // List state
  const { data, isLoading } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TablesListResponse>('/api/dashboard/tables'),
  })
  const userTables = data?.userTables ?? []
  const systemTables = data?.systemTables ?? []

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [tableName, setTableName] = useState('')
  const [columns, setColumns] = useState<ColumnBuilder[]>(defaultColumns())
  const [creating, setCreating] = useState(false)

  // Describe dialog state
  const [describeTarget, setDescribeTarget] = useState<string | null>(null)

  // Drop confirm state
  const [dropTarget, setDropTarget] = useState<UserTable | null>(null)
  const [dropping, setDropping] = useState(false)

  // Auto-prefix usr_ for the table name input.
  const effectiveName = useMemo(() => {
    const raw = tableName.trim()
    if (!raw) return ''
    if (raw.toLowerCase().startsWith('usr_')) return raw
    return `usr_${raw}`
  }, [tableName])

  const nameValid =
    effectiveName.length > 4 &&
    effectiveName.length <= 64 &&
    IDENT_RE.test(effectiveName) &&
    !userTables.some((t) => t.name === effectiveName)

  const columnsValid =
    columns.length > 0 &&
    columns.every((c) => IDENT_RE.test(c.name)) &&
    // Unique names
    new Set(columns.map((c) => c.name)).size === columns.length

  // Describe query — runs only when describeTarget is set.
  const { data: describeData, isLoading: describeLoading } = useQuery({
    queryKey: ['table-describe', describeTarget],
    queryFn: () =>
      api<DescribeResponse>(
        `/api/dashboard/tables/${encodeURIComponent(describeTarget!)}`,
      ),
    enabled: !!describeTarget,
  })

  // ─── Handlers ───────────────────────────────────────────────────────────

  function resetCreateForm() {
    setTableName('')
    setColumns(defaultColumns())
  }

  function openCreate() {
    resetCreateForm()
    setCreateOpen(true)
  }

  function updateColumn(id: string, patch: Partial<ColumnBuilder>) {
    setColumns((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        // AUTOINCREMENT only makes sense for INTEGER PRIMARY KEY columns.
        if (next.type !== 'INTEGER' || !next.primary) {
          next.autoIncrement = false
        }
        // PRIMARY KEY columns are implicitly NOT NULL — hide the nullable
        // toggle visually but keep state consistent.
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
        name: effectiveName,
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
      toast.success(`Table "${effectiveName}" created`)
      setCreateOpen(false)
      qc.invalidateQueries({ queryKey: ['tables'] })
      // Open the describe view for the newly-created table.
      setDescribeTarget(effectiveName)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  async function confirmDrop() {
    if (!dropTarget) return
    setDropping(true)
    try {
      await api(`/api/dashboard/tables/${encodeURIComponent(dropTarget.name)}`, {
        method: 'DELETE',
      })
      toast.success(`Dropped table "${dropTarget.name}"`)
      setDropTarget(null)
      qc.invalidateQueries({ queryKey: ['tables'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Drop failed')
    } finally {
      setDropping(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader
        title="Tables"
        description="Manage your custom usr_* tables with a form-based UI, or query them via the SQL Editor."
        actions={
          <Button
            size="sm"
            onClick={openCreate}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" /> New table
          </Button>
        }
      />

      {/* Info banner */}
      <Card className="bg-primary/5 border-primary/20 p-4 mb-4 flex items-start gap-3">
        <Info className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="text-xs text-stone-700">
          Custom tables live in the SQLite database and are visible across your
          entire workspace. They must be prefixed with{' '}
          <code className="font-mono text-primary">usr_</code>. Use the{' '}
          <strong>SQL Editor</strong> tab to run INSERT / UPDATE / DELETE /
          SELECT against them.
        </div>
      </Card>

      {/* Your tables (usr_*) */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Table2 className="size-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">
            Your tables (usr_*)
          </h2>
          <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary/80">
            {userTables.length}
          </Badge>
        </div>

        <Card className="bg-card/40 border-border/60 overflow-hidden">
          {isLoading ? (
            <div className="py-16 grid place-items-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : userTables.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No custom tables yet. Click <strong>New table</strong> to create one.
            </div>
          ) : isMobile ? (
            // Mobile: card list
            <div className="p-3 space-y-2.5">
              {userTables.map((t) => (
                <div
                  key={t.name}
                  className="rounded-md border border-border/60 bg-card/60 p-3 space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <Table2 className="size-4 text-primary mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm font-medium text-foreground break-all">
                        {t.name}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] border-primary/30 text-primary shrink-0"
                    >
                      user
                    </Badge>
                  </div>
                  <div className="flex items-center justify-end gap-1.5 pt-1.5 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => setDescribeTarget(t.name)}
                    >
                      <Eye className="size-3.5" /> View
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 border-red-400/30 text-red-500 hover:bg-red-50 hover:text-red-600"
                      onClick={() => setDropTarget(t)}
                    >
                      <Trash2 className="size-3.5" /> Drop
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/40">
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Name
                  </TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Type
                  </TableHead>
                  <TableHead className="text-right font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userTables.map((t) => (
                  <TableRow key={t.name} className="border-border/30 group">
                    <TableCell className="font-mono text-sm font-medium py-2.5">
                      {t.name}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] border-primary/30 text-primary"
                      >
                        user
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 opacity-70 group-hover:opacity-100"
                        onClick={() => setDescribeTarget(t.name)}
                      >
                        <Eye className="size-3.5" /> View
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-60 group-hover:opacity-100 hover:text-red-400"
                        onClick={() => setDropTarget(t)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      {/* System virtual tables */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Database className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">
            System virtual tables
          </h2>
          <Badge variant="outline" className="font-mono text-[10px] border-muted-foreground/30 text-muted-foreground">
            read-only
          </Badge>
        </div>

        <Card className="bg-card/40 border-border/60 overflow-hidden">
          {isMobile ? (
            <div className="p-3 space-y-2.5">
              {systemTables.map((t) => (
                <div
                  key={t.name}
                  className="rounded-md border border-border/60 bg-card/60 p-3 space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <Database className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm font-medium text-foreground break-all">
                        {t.name}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] border-muted-foreground/30 text-muted-foreground shrink-0"
                    >
                      virtual
                    </Badge>
                  </div>
                  <div className="flex items-center justify-end pt-1.5 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => setDescribeTarget(t.name)}
                    >
                      <Eye className="size-3.5" /> View
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/40">
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Name
                  </TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Type
                  </TableHead>
                  <TableHead className="text-right font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {systemTables.map((t) => (
                  <TableRow key={t.name} className="border-border/30 group">
                    <TableCell className="font-mono text-sm font-medium py-2.5">
                      {t.name}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] border-muted-foreground/30 text-muted-foreground"
                      >
                        virtual
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 opacity-70 group-hover:opacity-100"
                        onClick={() => setDescribeTarget(t.name)}
                      >
                        <Eye className="size-3.5" /> View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      {/* ─── Create dialog ──────────────────────────────────────────────── */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v)
          if (!v) resetCreateForm()
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Table2 className="size-4 text-primary" /> Create custom table
            </DialogTitle>
            <DialogDescription>
              Define the table name and columns. The table will be created in
              SQLite and immediately queryable from the SQL Editor.
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
                The <code className="font-mono">usr_</code> prefix is added
                automatically if you don&apos;t type it.
              </span>
              <span
                className={
                  effectiveName
                    ? nameValid
                      ? 'font-mono text-emerald-600'
                      : 'font-mono text-red-500'
                    : 'font-mono text-muted-foreground/60'
                }
              >
                {effectiveName || 'usr_…'}
              </span>
            </div>
            {effectiveName &&
              userTables.some((t) => t.name === effectiveName) && (
                <p className="text-[11px] text-red-500">
                  A table named &quot;{effectiveName}&quot; already exists.
                </p>
              )}
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
              {/* Header row (desktop only) */}
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
                    {/* Name */}
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

                    {/* Type */}
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

                    {/* PK + Auto-increment */}
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

                    {/* NOT NULL */}
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

                    {/* Default */}
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

                    {/* Remove */}
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

            {/* Duplicate name detection */}
            {columns.length > 0 &&
              new Set(columns.map((c) => c.name)).size !== columns.length && (
                <p className="text-[11px] text-red-500">
                  Column names must be unique.
                </p>
              )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
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

      {/* ─── Describe dialog ────────────────────────────────────────────── */}
      <Dialog
        open={!!describeTarget}
        onOpenChange={(v) => !v && setDescribeTarget(null)}
      >
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono">
              <Table2 className="size-4 text-primary" /> {describeTarget}
            </DialogTitle>
            <DialogDescription>
              {describeData?.isVirtual
                ? 'Virtual table — queryable via the SQL Editor only.'
                : 'Schema and a sample of up to 100 rows.'}
            </DialogDescription>
          </DialogHeader>

          {describeLoading ? (
            <div className="py-12 grid place-items-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : describeData?.isVirtual ? (
            // Virtual table info
            <Card className="p-4 bg-primary/5 border-primary/20 flex items-start gap-3">
              <Info className="size-4 text-primary mt-0.5 shrink-0" />
              <div className="text-sm text-stone-700 space-y-1">
                <p>
                  <code className="font-mono text-primary">
                    {describeData.name}
                  </code>{' '}
                  is a virtual, read-only view over your account data. It
                  cannot be dropped or modified directly.
                </p>
                <p>
                  Open the <strong>SQL Editor</strong> tab to run SELECT
                  queries against it. INSERT / UPDATE / DELETE are only
                  supported on the <code className="font-mono">records</code>{' '}
                  and <code className="font-mono">collections</code> virtual
                  tables.
                </p>
              </div>
            </Card>
          ) : describeData ? (
            <div className="space-y-4">
              {/* Column list */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <KeyRound className="size-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
                    Columns ({describeData.columns.length})
                  </span>
                </div>
                <Card className="bg-card/40 border-border/60 overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent border-border/40">
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          Name
                        </TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          Type
                        </TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          Flags
                        </TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          Default
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {describeData.columns.map((col) => (
                        <TableRow key={col.name} className="border-border/30">
                          <TableCell className="font-mono text-xs font-medium py-2">
                            {col.name}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {col.type || '—'}
                          </TableCell>
                          <TableCell className="py-2">
                            <div className="flex items-center gap-1 flex-wrap">
                              {col.pk > 0 && (
                                <Badge
                                  variant="outline"
                                  className="font-mono text-[9px] border-primary/40 text-primary"
                                >
                                  PK
                                </Badge>
                              )}
                              {col.notnull && (
                                <Badge
                                  variant="outline"
                                  className="font-mono text-[9px] border-amber-500/40 text-amber-600"
                                >
                                  NOT NULL
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {col.default ?? '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </div>

              {/* Sample rows */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Database className="size-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
                    Sample rows ({describeData.sampleRows.length} of{' '}
                    {describeData.rowCount})
                  </span>
                </div>
                <Card className="bg-card/40 border-border/60 overflow-hidden">
                  {describeData.sampleRows.length === 0 ? (
                    <div className="py-10 text-center text-xs text-muted-foreground/60">
                      No rows in this table yet.
                    </div>
                  ) : (
                    <div className="max-h-96 overflow-y-auto scroll-slim">
                      <Table>
                        <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                          <TableRow className="hover:bg-transparent border-border/40">
                            {Object.keys(describeData.sampleRows[0]).map(
                              (col) => (
                                <TableHead
                                  key={col}
                                  className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 whitespace-nowrap"
                                >
                                  {col}
                                </TableHead>
                              ),
                            )}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {describeData.sampleRows.map((row, i) => (
                            <TableRow key={i} className="border-border/30">
                              {Object.keys(describeData.sampleRows[0]).map(
                                (col) => (
                                  <TableCell
                                    key={col}
                                    className="font-mono text-xs py-2 max-w-[260px] truncate"
                                    title={formatCell(row[col])}
                                  >
                                    {formatCell(row[col])}
                                  </TableCell>
                                ),
                              )}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Card>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDescribeTarget(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Drop confirm ──────────────────────────────────────────────── */}
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
              This permanently deletes the table and all of its data. The
              action cannot be undone. Use the SQL Editor to back up your data
              first if needed.
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
