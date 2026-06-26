'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TypeBadge } from './shared'
import { useApi, type RecordView, type CollectionView } from '@/lib/api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** existing record to edit, or null to create */
  record?: RecordView | null
}

const TYPES = ['string', 'number', 'boolean', 'object', 'array']

export function RecordDialog({ open, onOpenChange, record }: Props) {
  const api = useApi()
  const qc = useQueryClient()
  const [key, setKey] = useState('')
  const [rawValue, setRawValue] = useState('')
  const [type, setType] = useState('string')
  const [collection, setCollection] = useState('default')
  const [saving, setSaving] = useState(false)

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: CollectionView[] }>('/api/dashboard/collections'),
    enabled: open,
  })
  const collections = collectionsData?.collections ?? []

  useEffect(() => {
    if (open) {
      if (record) {
        setKey(record.key)
        setCollection(record.collection)
        setType(record.valueType)
        setRawValue(formatForEditor(record.value, record.valueType))
      } else {
        setKey('')
        setRawValue('')
        setType('string')
        setCollection('default')
      }
    }
  }, [open, record])

  // Re-format the editor contents when the user switches type.
  function changeType(next: string) {
    setType(next)
    setRawValue((cur) => coerceToType(cur, next))
  }

  function buildValue(): unknown {
    return parseForStorage(rawValue, type)
  }

  async function save() {
    if (!key.trim()) {
      toast.error('Key is required')
      return
    }
    setSaving(true)
    try {
      await api('/api/dashboard/records', {
        method: 'POST',
        body: JSON.stringify({ key: key.trim(), value: buildValue(), collection }),
      })
      toast.success(record ? 'Record updated' : 'Record created')
      qc.invalidateQueries({ queryKey: ['records'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['logs'] })
      qc.invalidateQueries({ queryKey: ['collections'] })
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit record' : 'New record'}</DialogTitle>
          <DialogDescription>
            Stored as typed JSON. Writes mirror to Telegram instantly.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Key</Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="coins"
                className="font-mono text-sm h-9"
                disabled={!!record}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Collection</Label>
              <Select value={collection} onValueChange={setCollection} disabled={!!record}>
                <SelectTrigger className="h-9 font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((c) => (
                    <SelectItem key={c.id} value={c.name} className="font-mono text-sm">
                      {c.name}
                    </SelectItem>
                  ))}
                  {!collections.some((c) => c.name === 'default') && (
                    <SelectItem value="default">default</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Type</Label>
              <TypeBadge type={type} />
            </div>
            <Select value={type} onValueChange={changeType}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="font-mono text-sm">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Value</Label>
            <Textarea
              value={rawValue}
              onChange={(e) => setRawValue(e.target.value)}
              placeholder={type === 'string' ? '500' : type === 'boolean' ? 'true' : type === 'object' ? '{\n  "name": "alice"\n}' : '[]'}
              className="font-mono text-sm min-h-[120px] resize-y"
            />
            <p className="text-[11px] text-muted-foreground/70">
              {type === 'object' || type === 'array' ? 'Valid JSON required.' : type === 'number' ? 'Numeric value.' : type === 'boolean' ? 'true or false.' : 'Plain text.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {record ? 'Save changes' : 'Create record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatForEditor(value: unknown, type: string): string {
  if (type === 'object' || type === 'array') return JSON.stringify(value, null, 2)
  return String(value)
}

function parseForStorage(raw: string, type: string): unknown {
  switch (type) {
    case 'number':
      return Number(raw)
    case 'boolean':
      return raw.trim() === 'true'
    case 'object': {
      try {
        return JSON.parse(raw)
      } catch {
        return {}
      }
    }
    case 'array': {
      try {
        return JSON.parse(raw)
      } catch {
        return []
      }
    }
    default:
      return raw
  }
}

function coerceToType(cur: string, next: string): string {
  const parsed = parseForStorage(cur, next === 'string' ? 'string' : next)
  return formatForEditor(parsed, next)
}
