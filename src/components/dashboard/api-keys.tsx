'use client'

import { useState, useMemo, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KeyRound, Plus, Trash2, Copy, Loader2, ShieldAlert, CheckCircle2,
  Clock, Gauge, Database, Pencil, Crown,
} from 'lucide-react'
import { useApi, type ApiKeyView } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageHeader } from './shell'
import { maskKey, timeAgo } from './shared'
import { useIsMobile } from '@/hooks/use-mobile'
import { toast } from 'sonner'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

// ─── Scope metadata ─────────────────────────────────────────────────────────

const ALL_SCOPES = [
  'read', 'write', 'delete', 'files', 'tables', 'collections', 'export',
] as const
type ScopeName = (typeof ALL_SCOPES)[number]

const SCOPE_LABELS: Record<ScopeName, string> = {
  read: 'Read',
  write: 'Write',
  delete: 'Delete',
  files: 'Files',
  tables: 'Tables',
  collections: 'Collections',
  export: 'Export',
}

const SCOPE_HINTS: Record<ScopeName, string> = {
  read: 'GET /v1/get, list, stats, logs',
  write: 'POST /v1/set',
  delete: 'DELETE /v1/delete',
  files: '/v1/files/* upload & download',
  tables: '/v1/tables/* schema + rows',
  collections: '/v1/collections/*',
  export: 'GET /v1/export',
}

const SCOPE_BADGE_CLASS: Record<ScopeName, string> = {
  read: 'border-emerald-400/30 text-emerald-600 dark:text-emerald-400',
  write: 'border-amber-400/30 text-amber-600 dark:text-amber-400',
  delete: 'border-red-400/30 text-red-600 dark:text-red-400',
  files: 'border-violet-400/30 text-violet-600 dark:text-violet-400',
  tables: 'border-cyan-400/30 text-cyan-600 dark:text-cyan-400',
  collections: 'border-pink-400/30 text-pink-600 dark:text-pink-400',
  export: 'border-orange-400/30 text-orange-600 dark:text-orange-400',
}

/**
 * Defensively default any missing v3 fields on an API key view. Old keys
 * created before scopes/rate-limits existed (or stale responses from a
 * pre-migration server) won't have these — treat them as full-access /
 * unlimited so the UI never crashes.
 */
function normalizeKey(k: ApiKeyView): ApiKeyView {
  return {
    ...k,
    scopes: Array.isArray(k.scopes) ? k.scopes : [],
    expiresAt: k.expiresAt ?? null,
    collectionAllowList: Array.isArray(k.collectionAllowList) ? k.collectionAllowList : [],
    tableAllowList: Array.isArray(k.tableAllowList) ? k.tableAllowList : [],
    rateLimitPerMin: k.rateLimitPerMin ?? null,
    rateLimitMbPerDay: k.rateLimitMbPerDay ?? null,
  }
}

// ─── Form state ─────────────────────────────────────────────────────────────

interface KeyFormState {
  name: string
  scopes: ScopeName[]
  neverExpires: boolean
  expiresAt: string // datetime-local string
  collectionAllowList: string // comma-separated
  tableAllowList: string // comma-separated
  rateLimitPerMin: string // empty = unlimited
  rateLimitMbPerDay: string // empty = unlimited
}

const EMPTY_FORM: KeyFormState = {
  name: '',
  scopes: [],
  neverExpires: true,
  expiresAt: '',
  collectionAllowList: '',
  tableAllowList: '',
  rateLimitPerMin: '',
  rateLimitMbPerDay: '',
}

function formFromKey(k: ApiKeyView): KeyFormState {
  let expiresAtLocal = ''
  if (k.expiresAt) {
    // Convert ISO to datetime-local value (YYYY-MM-DDTHH:MM)
    const d = new Date(k.expiresAt)
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0')
      expiresAtLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  }
  return {
    name: k.name,
    scopes: k.scopes.filter((s): s is ScopeName => (ALL_SCOPES as readonly string[]).includes(s)),
    neverExpires: !k.expiresAt,
    expiresAt: expiresAtLocal,
    collectionAllowList: k.collectionAllowList.join(', '),
    tableAllowList: k.tableAllowList.join(', '),
    rateLimitPerMin: k.rateLimitPerMin ? String(k.rateLimitPerMin) : '',
    rateLimitMbPerDay: k.rateLimitMbPerDay ? String(k.rateLimitMbPerDay) : '',
  }
}

function formToBody(f: KeyFormState, isUpdate: false): Record<string, unknown>
function formToBody(f: KeyFormState, isUpdate: true): Record<string, unknown>
function formToBody(f: KeyFormState, _isUpdate: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { name: f.name.trim() || 'new-key' }
  body.scopes = f.scopes
  body.expiresAt = f.neverExpires || !f.expiresAt ? null : new Date(f.expiresAt).toISOString()
  body.collectionAllowList = f.collectionAllowList
    .split(',').map((s) => s.trim()).filter(Boolean)
  body.tableAllowList = f.tableAllowList
    .split(',').map((s) => s.trim()).filter(Boolean)
  body.rateLimitPerMin = f.rateLimitPerMin ? Number(f.rateLimitPerMin) : null
  body.rateLimitMbPerDay = f.rateLimitMbPerDay ? Number(f.rateLimitMbPerDay) : null
  return body
}

function isExpired(k: ApiKeyView): boolean {
  if (!k.expiresAt) return false
  const t = Date.parse(k.expiresAt)
  return !Number.isNaN(t) && Date.now() > t
}

function isLimited(k: ApiKeyView): boolean {
  return !!(k.rateLimitPerMin || k.rateLimitMbPerDay)
}

// ─── Scope checkbox grid ────────────────────────────────────────────────────

function ScopeCheckboxes({
  scopes,
  onChange,
}: {
  scopes: ScopeName[]
  onChange: (next: ScopeName[]) => void
}) {
  function toggle(s: ScopeName) {
    onChange(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s])
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {ALL_SCOPES.map((s) => (
        <label
          key={s}
          htmlFor={`scope-${s}`}
          className="flex items-start gap-2.5 rounded-md border border-border/50 bg-card/30 p-2.5 cursor-pointer hover:bg-card/60 transition-colors"
        >
          <Checkbox
            id={`scope-${s}`}
            checked={scopes.includes(s)}
            onCheckedChange={() => toggle(s)}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{SCOPE_LABELS[s]}</div>
            <div className="text-[11px] text-muted-foreground/70 font-mono truncate">{SCOPE_HINTS[s]}</div>
          </div>
        </label>
      ))}
    </div>
  )
}

// ─── The create/edit form (used inside Dialog) ──────────────────────────────

function ApiKeyForm({
  form,
  setForm,
  mode,
}: {
  form: KeyFormState
  setForm: (f: KeyFormState) => void
  mode: 'create' | 'edit'
}) {
  const update = (patch: Partial<KeyFormState>) => setForm({ ...form, ...patch })
  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor="ak-name" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Name</Label>
        <Input
          id="ak-name"
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Production"
          className="font-mono text-sm"
          autoFocus={mode === 'create'}
        />
      </div>

      <Separator />

      {/* Scopes */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Scopes</Label>
          {form.scopes.length === 0 ? (
            <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">
              <Crown className="size-2.5 mr-1" /> Full access
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground/70 font-mono">{form.scopes.length} selected</span>
          )}
        </div>
        <ScopeCheckboxes scopes={form.scopes} onChange={(next) => update({ scopes: next })} />
        <p className="text-[11px] text-muted-foreground/70">
          Selecting nothing grants <strong className="text-primary">full access</strong> (backward compatible).
          Pick specific scopes to limit what this key can do.
        </p>
      </div>

      <Separator />

      {/* Expiry */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Expiry</Label>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-[11px] text-muted-foreground/70">Never expires</span>
            <Switch
              checked={form.neverExpires}
              onCheckedChange={(v) => update({ neverExpires: v })}
              aria-label="Never expires"
            />
          </label>
        </div>
        {!form.neverExpires && (
          <Input
            type="datetime-local"
            value={form.expiresAt}
            onChange={(e) => update({ expiresAt: e.target.value })}
            className="font-mono text-sm"
          />
        )}
      </div>

      <Separator />

      {/* Allowlists */}
      <div className="space-y-2">
        <Label htmlFor="ak-coll" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Collection allowlist
        </Label>
        <Input
          id="ak-coll"
          value={form.collectionAllowList}
          onChange={(e) => update({ collectionAllowList: e.target.value })}
          placeholder="users, logs, sessions  (empty = all)"
          className="font-mono text-sm"
        />
        <p className="text-[11px] text-muted-foreground/70">Comma-separated. Empty = access to all collections.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ak-tables" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Table allowlist
        </Label>
        <Input
          id="ak-tables"
          value={form.tableAllowList}
          onChange={(e) => update({ tableAllowList: e.target.value })}
          placeholder="orders, events  (empty = all)"
          className="font-mono text-sm"
        />
        <p className="text-[11px] text-muted-foreground/70">Comma-separated. Empty = access to all tables.</p>
      </div>

      <Separator />

      {/* Rate limits */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ak-rpm" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Req / min
          </Label>
          <Input
            id="ak-rpm"
            type="number"
            min={1}
            value={form.rateLimitPerMin}
            onChange={(e) => update({ rateLimitPerMin: e.target.value })}
            placeholder="∞"
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ak-mb" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            MB / day
          </Label>
          <Input
            id="ak-mb"
            type="number"
            min={1}
            value={form.rateLimitMbPerDay}
            onChange={(e) => update({ rateLimitMbPerDay: e.target.value })}
            placeholder="∞"
            className="font-mono text-sm"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/70">Leave empty for unlimited. MB/day counts bytes written (UTC reset).</p>
    </div>
  )
}

// ─── Main view ──────────────────────────────────────────────────────────────

export function ApiKeysView() {
  const api = useApi()
  const qc = useQueryClient()
  const isMobile = useIsMobile()

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<KeyFormState>(EMPTY_FORM)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [editTarget, setEditTarget] = useState<ApiKeyView | null>(null)
  const [editForm, setEditForm] = useState<KeyFormState>(EMPTY_FORM)
  const [editOpen, setEditOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null)
  const [revoking, setRevoking] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<{ apiKeys: ApiKeyView[] }>('/api/dashboard/api-keys'),
  })
  const keys = useMemo(() => (data?.apiKeys ?? []).map(normalizeKey), [data])

  async function create() {
    if (!createForm.name.trim()) return
    setCreating(true)
    try {
      const res = await api<{ apiKey: ApiKeyView }>('/api/dashboard/api-keys', {
        method: 'POST',
        body: JSON.stringify(formToBody(createForm, false)),
      })
      setCreatedKey(res.apiKey.key)
      setCreateForm(EMPTY_FORM)
      setCreateOpen(false)
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      toast.success('API key created')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  function openEdit(k: ApiKeyView) {
    const nk = normalizeKey(k)
    setEditTarget(nk)
    setEditForm(formFromKey(nk))
    setEditOpen(true)
  }

  async function saveEdit() {
    if (!editTarget) return
    setSaving(true)
    try {
      await api(`/api/dashboard/api-keys/${editTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify(formToBody(editForm, true)),
      })
      toast.success(`Updated "${editForm.name || editTarget.name}"`)
      setEditOpen(false)
      setEditTarget(null)
      qc.invalidateQueries({ queryKey: ['api-keys'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await api(`/api/dashboard/api-keys/${revokeTarget.id}`, { method: 'DELETE' })
      toast.success(`Revoked "${revokeTarget.name}"`)
      setRevokeTarget(null)
      qc.invalidateQueries({ queryKey: ['api-keys'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setRevoking(false)
    }
  }

  async function copy(key: string) {
    await navigator.clipboard.writeText(key)
    toast.success('API key copied')
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Scoped, rate-limited, expiring bearer tokens for the CLI and REST API."
        actions={
          <Button size="sm" onClick={() => { setCreateForm(EMPTY_FORM); setCreateOpen(true) }} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="size-4" /> New key
          </Button>
        }
      />

      <Card className="bg-primary/5 border-primary/20 p-4 mb-4 flex items-start gap-3">
        <ShieldAlert className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="text-xs text-stone-700 dark:text-stone-300">
          Each key can be scoped to specific operations, restricted to certain collections/tables,
          rate-limited, and set to expire. Keys with <strong className="text-primary">no scopes</strong> selected
          have full access. New keys are shown <strong className="text-primary">only once</strong> after creation.
        </div>
      </Card>

      <Card className="bg-card/40 border-border/60 overflow-hidden">
        {isLoading ? (
          <div className="py-16 grid place-items-center"><Loader2 className="size-5 animate-spin text-primary" /></div>
        ) : keys.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">No API keys yet.</div>
        ) : isMobile ? (
          // Mobile: card list — no horizontal scroll, big touch targets.
          <div className="p-3 space-y-2.5 max-h-[70vh] overflow-y-auto">
            {keys.map((k) => (
              <div
                key={k.id}
                className="rounded-md border border-border/60 bg-card/60 p-3 space-y-2.5"
              >
                <div className="flex items-start gap-2">
                  <KeyRound className="size-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm break-words">{k.name}</div>
                    <code className="font-mono text-xs text-muted-foreground break-all">{maskKey(k.key)}</code>
                  </div>
                  <StatusBadge k={k} />
                </div>

                <ScopesRow k={k} />

                {(isLimited(k) || k.expiresAt || k.collectionAllowList.length > 0 || k.tableAllowList.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/40">
                    <LimitsBadges k={k} />
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-border/40">
                  <div className="text-[11px] text-muted-foreground/70 font-mono shrink-0">
                    {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : 'never used'}
                    <span className="mx-1.5">·</span>
                    {timeAgo(k.createdAt)}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => copy(k.key)}
                      className="size-9 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                      aria-label="Copy API key"
                    >
                      <Copy className="size-4" />
                    </button>
                    <button
                      onClick={() => openEdit(k)}
                      disabled={k.revoked}
                      className="size-9 grid place-items-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                      aria-label="Edit key restrictions"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      onClick={() => setRevokeTarget(k)}
                      disabled={k.revoked}
                      className="size-9 grid place-items-center rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                      aria-label="Revoke key"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/40 sticky top-0 bg-card/95 backdrop-blur z-10">
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Key</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Status</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Scopes</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Limits</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden lg:table-cell">Used</TableHead>
                  <TableHead className="text-right font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id} className="border-border/30 group align-top">
                    <TableCell className="font-medium py-2.5">
                      <div className="break-words">{k.name}</div>
                      <div className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">{timeAgo(k.createdAt)}</div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <code className="font-mono text-xs text-muted-foreground">{maskKey(k.key)}</code>
                        <Button variant="ghost" size="icon" className="size-6 opacity-60 group-hover:opacity-100" onClick={() => copy(k.key)}>
                          <Copy className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5"><StatusBadge k={k} /></TableCell>
                    <TableCell className="py-2.5 max-w-[220px]">
                      <ScopesRow k={k} compact />
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex flex-col gap-1">
                        <LimitsBadges k={k} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell py-2.5 text-[11px] text-muted-foreground/70 font-mono">
                      {k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}
                    </TableCell>
                    <TableCell className="text-right py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-60 group-hover:opacity-100 hover:text-primary"
                          disabled={k.revoked}
                          onClick={() => openEdit(k)}
                          aria-label="Edit restrictions"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-60 group-hover:opacity-100 hover:text-red-400"
                          disabled={k.revoked}
                          onClick={() => setRevokeTarget(k)}
                        >
                          <Trash2 className="size-3.5" />
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

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Scope, rate-limit, and expire the key. You can edit these later.</DialogDescription>
          </DialogHeader>
          <ApiKeyForm form={createForm} setForm={setCreateForm} mode="create" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating || !createForm.name.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={(v) => { setEditOpen(v); if (!v) setEditTarget(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="size-4 text-primary" /> Edit "{editTarget?.name}"
            </DialogTitle>
            <DialogDescription>Update scopes, expiry, allowlists, and rate limits.</DialogDescription>
          </DialogHeader>
          <ApiKeyForm form={editForm} setForm={setEditForm} mode="edit" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setEditOpen(false); setEditTarget(null) }}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal newly created key */}
      <Dialog open={!!createdKey} onOpenChange={(v) => !v && setCreatedKey(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" /> API key created
            </DialogTitle>
            <DialogDescription>Copy it now — you won&apos;t see the full key again.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <code className="font-mono text-sm text-primary break-all">{createdKey}</code>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => createdKey && copy(createdKey)}>
              <Copy className="size-4" /> Copy
            </Button>
            <Button onClick={() => setCreatedKey(null)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(v) => !v && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke "{revokeTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Any CLI or API request using this key will immediately stop working. The key cannot be reactivated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke} disabled={revoking} className="bg-red-500 hover:bg-red-600 text-white">
              {revoking ? <Loader2 className="size-4 animate-spin" /> : null} Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Presentational helpers ─────────────────────────────────────────────────

function StatusBadge({ k }: { k: ApiKeyView }) {
  if (k.revoked) {
    return <Badge variant="outline" className="font-mono text-[10px] border-red-400/30 text-red-500">revoked</Badge>
  }
  if (isExpired(k)) {
    return <Badge variant="outline" className="font-mono text-[10px] border-amber-400/40 text-amber-600">expired</Badge>
  }
  return (
    <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">
      <CheckCircle2 className="size-2.5 mr-1" /> active
    </Badge>
  )
}

function ScopesRow({ k, compact }: { k: ApiKeyView; compact?: boolean }) {
  if (k.scopes.length === 0) {
    return (
      <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">
        <Crown className="size-2.5 mr-1" /> Full access
      </Badge>
    )
  }
  if (compact) {
    return (
      <div className="flex flex-wrap gap-1">
        {k.scopes.map((s) => (
          <Badge key={s} variant="outline" className={`font-mono text-[10px] ${SCOPE_BADGE_CLASS[s as ScopeName] || ''}`}>
            {s}
          </Badge>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {k.scopes.map((s) => (
        <Badge key={s} variant="outline" className={`font-mono text-[10px] ${SCOPE_BADGE_CLASS[s as ScopeName] || ''}`}>
          {SCOPE_LABELS[s as ScopeName] || s}
        </Badge>
      ))}
    </div>
  )
}

function LimitsBadges({ k }: { k: ApiKeyView }) {
  const badges: ReactNode[] = []
  if (k.rateLimitPerMin) {
    badges.push(
      <Badge key="rpm" variant="outline" className="font-mono text-[10px] border-border/60 text-muted-foreground">
        <Gauge className="size-2.5 mr-1" /> {k.rateLimitPerMin}/min
      </Badge>,
    )
  }
  if (k.rateLimitMbPerDay) {
    badges.push(
      <Badge key="mbd" variant="outline" className="font-mono text-[10px] border-border/60 text-muted-foreground">
        <Database className="size-2.5 mr-1" /> {k.rateLimitMbPerDay}MB/day
      </Badge>,
    )
  }
  if (k.expiresAt) {
    const expired = isExpired(k)
    badges.push(
      <Badge key="exp" variant="outline" className={`font-mono text-[10px] ${expired ? 'border-amber-400/40 text-amber-600' : 'border-border/60 text-muted-foreground'}`}>
        <Clock className="size-2.5 mr-1" /> {expired ? 'expired' : `exp ${new Date(k.expiresAt).toLocaleDateString()}`}
      </Badge>,
    )
  }
  if (k.collectionAllowList.length) {
    badges.push(
      <Badge key="coll" variant="outline" className="font-mono text-[10px] border-border/60 text-muted-foreground">
        {k.collectionAllowList.length} coll{k.collectionAllowList.length > 1 ? 's' : ''}
      </Badge>,
    )
  }
  if (k.tableAllowList.length) {
    badges.push(
      <Badge key="tbl" variant="outline" className="font-mono text-[10px] border-border/60 text-muted-foreground">
        {k.tableAllowList.length} table{k.tableAllowList.length > 1 ? 's' : ''}
      </Badge>,
    )
  }
  if (badges.length === 0) {
    return <span className="text-[11px] text-muted-foreground/50 font-mono">unlimited</span>
  }
  return <>{badges}</>
}
