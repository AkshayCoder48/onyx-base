'use client'

import { useQuery } from '@tanstack/react-query'
import { ScrollText, Loader2, RefreshCw } from 'lucide-react'
import { useApi, type LogView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useState } from 'react'
import { PageHeader } from './shell'
import { toast } from 'sonner'

const ACTION_STYLES: Record<string, string> = {
  set: 'border-primary/30 text-primary bg-primary/10',
  get: 'border-sky-300 text-sky-800 bg-sky-100',
  delete: 'border-red-300 text-red-700 bg-red-100',
  login: 'border-amber-300 text-amber-800 bg-amber-100',
  export: 'border-violet-300 text-violet-800 bg-violet-100',
}

const SOURCE_STYLES: Record<string, string> = {
  cli: 'text-primary',
  api: 'text-sky-300',
  dashboard: 'text-violet-300',
  system: 'text-muted-foreground',
}

export function LogsView() {
  const api = useApi()
  const [filter, setFilter] = useState<string>('all')
  const user = useOnyxBase((s) => s.user)

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['logs', filter],
    queryFn: () =>
      api<{ logs: LogView[] }>(`/api/dashboard/logs?limit=200${filter !== 'all' ? `&action=${filter}` : ''}`),
    refetchInterval: 8000,
  })
  const logs = data?.logs ?? []

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Every read, write, and auth event on your account."
        actions={
          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="h-9 w-36 font-mono text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all actions</SelectItem>
                <SelectItem value="set">set</SelectItem>
                <SelectItem value="get">get</SelectItem>
                <SelectItem value="delete">delete</SelectItem>
                <SelectItem value="login">login</SelectItem>
                <SelectItem value="export">export</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        }
      />

      <Card className="bg-card/40 border-border/60 overflow-hidden">
        {isLoading ? (
          <div className="py-16 grid place-items-center"><Loader2 className="size-5 animate-spin text-primary" /></div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center">
            <ScrollText className="size-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No log entries yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/30 max-h-[70vh] overflow-y-auto scroll-slim">
            {logs.map((l) => (
              <div key={l.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30">
                <div className="w-[68px] shrink-0 text-[11px] font-mono text-muted-foreground/70 pt-0.5">
                  {new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
                <Badge variant="outline" className={`font-mono text-[10px] shrink-0 ${ACTION_STYLES[l.action] ?? 'border-border/40 text-muted-foreground'}`}>
                  {l.action}
                </Badge>
                <div className="flex-1 min-w-0 text-sm">
                  {l.key && <code className="font-mono text-foreground/90">{l.key}</code>}
                  {l.detail && <span className="ml-2 text-xs text-muted-foreground/70 font-mono">{l.detail}</span>}
                </div>
                <span className={`text-[11px] font-mono shrink-0 ${SOURCE_STYLES[l.source] ?? ''}`}>{l.source}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-3 text-xs text-muted-foreground/70 font-mono">
        {logs.length} entr{logs.length === 1 ? 'y' : 'ies'} · auto-refreshing every 8s
      </div>
    </div>
  )
}
