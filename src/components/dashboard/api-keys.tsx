'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus, Trash2, Copy, Loader2, ShieldAlert, CheckCircle2 } from 'lucide-react'
import { useApi, type ApiKeyView } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { PageHeader } from './shell'
import { maskKey, timeAgo } from './shared'
import { toast } from 'sonner'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

export function ApiKeysView() {
  const api = useApi()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null)
  const [revoking, setRevoking] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<{ apiKeys: ApiKeyView[] }>('/api/dashboard/api-keys'),
  })
  const keys = data?.apiKeys ?? []

  async function create() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const res = await api<{ apiKey: ApiKeyView }>('/api/dashboard/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      })
      setCreatedKey(res.apiKey.key)
      setNewName('')
      setCreateOpen(false)
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      toast.success('API key created')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
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
        description="Bearer tokens used by the CLI and REST API. Keep them secret."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="size-4" /> New key
          </Button>
        }
      />

      <Card className="bg-primary/5 border-primary/20 p-4 mb-4 flex items-start gap-3">
        <ShieldAlert className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="text-xs text-stone-700">
          Every API key grants full read/write access to your data. Use separate keys per environment and revoke
          compromised keys immediately. New keys are shown <strong className="text-primary">only once</strong> after creation.
        </div>
      </Card>

      <Card className="bg-card/40 border-border/60 overflow-hidden">
        {isLoading ? (
          <div className="py-16 grid place-items-center"><Loader2 className="size-5 animate-spin text-primary" /></div>
        ) : keys.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">No API keys yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/40">
                <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Key</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Status</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden sm:table-cell">Last used</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden md:table-cell">Created</TableHead>
                <TableHead className="text-right font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id} className="border-border/30 group">
                  <TableCell className="font-medium py-2.5">{k.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-xs text-muted-foreground">{maskKey(k.key)}</code>
                      <Button variant="ghost" size="icon" className="size-6 opacity-60 group-hover:opacity-100" onClick={() => copy(k.key)}>
                        <Copy className="size-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    {k.revoked ? (
                      <Badge variant="outline" className="font-mono text-[10px] border-red-400/30 text-red-300">revoked</Badge>
                    ) : (
                      <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">
                        <CheckCircle2 className="size-2.5 mr-1" /> active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-[11px] text-muted-foreground/70 font-mono">
                    {k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-[11px] text-muted-foreground/70 font-mono">{timeAgo(k.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-60 group-hover:opacity-100 hover:text-red-400"
                      disabled={k.revoked}
                      onClick={() => setRevokeTarget(k)}
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

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Give it a descriptive name (e.g. "Production", "Local CLI").</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Production"
            className="font-mono text-sm"
            onKeyDown={(e) => e.key === 'Enter' && create()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating || !newName.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Generate
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
