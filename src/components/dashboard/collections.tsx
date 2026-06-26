'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderTree, Plus, Trash2, Database, Loader2, FolderPlus } from 'lucide-react'
import { useApi, type CollectionView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { PageHeader } from './shell'
import { timeAgo } from './shared'
import { toast } from 'sonner'

export function CollectionsView() {
  const api = useApi()
  const qc = useQueryClient()
  const setView = useOnyxBase((s) => s.setView)
  const setCollection = useOnyxBase((s) => s.setCollection)

  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CollectionView | null>(null)
  const [deleting, setDeleting] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: CollectionView[] }>('/api/dashboard/collections'),
  })
  const collections = data?.collections ?? []

  async function create() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await api('/api/dashboard/collections', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) })
      toast.success(`Collection "${newName.trim()}" created`)
      setNewName('')
      setCreateOpen(false)
      qc.invalidateQueries({ queryKey: ['collections'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api(`/api/dashboard/collections/${encodeURIComponent(deleteTarget.name)}`, { method: 'DELETE' })
      toast.success(`Deleted collection "${deleteTarget.name}"`)
      setDeleteTarget(null)
      qc.invalidateQueries({ queryKey: ['collections'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  function openCollection(name: string) {
    setCollection(name)
    setView('database')
  }

  return (
    <div>
      <PageHeader
        title="Collections"
        description="Group related keys into namespaces. Like folders for your data."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <FolderPlus className="size-4" /> New collection
          </Button>
        }
      />

      {isLoading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="size-5 animate-spin text-primary" /></div>
      ) : collections.length === 0 ? (
        <Card className="bg-card/40 border-border/60 py-16 text-center">
          <FolderTree className="size-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No collections yet.</p>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {collections.map((c) => (
            <Card
              key={c.id}
              className="p-4 bg-card/40 border-border/60 hover:border-primary/30 transition-colors cursor-pointer group"
              onClick={() => openCollection(c.name)}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center">
                  <Database className="size-4 text-primary" />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 opacity-0 group-hover:opacity-100 hover:text-red-400"
                  disabled={c.name === 'default'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteTarget(c)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div className="font-mono text-sm font-medium truncate">{c.name}</div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span>{c.records} record{c.records === 1 ? '' : 's'}</span>
                <span>{timeAgo(c.createdAt)}</span>
              </div>
              {c.name === 'default' && (
                <span className="inline-block mt-2 text-[10px] font-mono px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground/70">
                  protected
                </span>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>Collections namespace your keys.</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="cache"
            className="font-mono text-sm"
            onKeyDown={(e) => e.key === 'Enter' && create()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating || !newName.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the collection and all {deleteTarget?.records} record{deleteTarget?.records === 1 ? '' : 's'} inside it. Cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting} className="bg-red-500 hover:bg-red-600 text-white">
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
