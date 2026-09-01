'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Heart,
  Database,
  Send,
  Wifi,
  Server,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { useApi } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { toast } from 'sonner'

interface HealthResponse {
  ok: boolean
  status: 'healthy' | 'degraded' | 'unhealthy'
  components: {
    api: 'healthy' | 'degraded' | 'unhealthy'
    database: 'healthy' | 'degraded' | 'unhealthy'
    telegram: 'healthy' | 'degraded' | 'unhealthy'
    realtime: 'healthy' | 'degraded' | 'unhealthy'
  }
  details: {
    api: string
    database: string
    telegram: string
    realtime: string
  }
  timestamp: string
  elapsedMs: number
  requestId?: string
}

interface QueueSnapshot {
  total: number
  pending: number
  inFlight: number
  durable: number
  retrying: number
  failed: number
  reconciled: number
  operations: Array<{
    id: string
    operation: string
    collection: string
    key: string
    status: string
    attempts: number
    maxAttempts: number
    lastError?: string
    lastErrorCategory?: string
    createdAt: number
    updatedAt: number
    nextAttemptAt: number
  }>
}

const STATUS_META: Record<
  'healthy' | 'degraded' | 'unhealthy',
  { color: string; bg: string; icon: typeof CheckCircle2; label: string }
> = {
  healthy: { color: 'text-emerald-600', bg: 'bg-emerald-500/10', icon: CheckCircle2, label: 'Healthy' },
  degraded: { color: 'text-amber-600', bg: 'bg-amber-500/10', icon: AlertTriangle, label: 'Degraded' },
  unhealthy: { color: 'text-red-600', bg: 'bg-red-500/10', icon: XCircle, label: 'Unhealthy' },
}

export function DiagnosticsView() {
  const api = useApi()
  const qc = useQueryClient()
  const [runningFull, setRunningFull] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const { data: health, refetch: refetchHealth, isFetching: healthFetching } = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('/api/health'),
    refetchInterval: 30000,
  })

  const { data: queue, refetch: refetchQueue } = useQuery({
    queryKey: ['storage-queue'],
    queryFn: () => api<QueueSnapshot>('/api/dashboard/diagnostics/queue'),
    refetchInterval: 15000,
  })

  async function runFullDiagnostic() {
    setRunningFull(true)
    try {
      // Force fresh fetches of health + queue.
      await Promise.all([refetchHealth(), refetchQueue()])
      // Hit the Telegram probe endpoint directly.
      await api('/api/dashboard/status?forceProbe=1', { method: 'GET' })
      qc.invalidateQueries({ queryKey: ['health'] })
      qc.invalidateQueries({ queryKey: ['storage-queue'] })
      qc.invalidateQueries({ queryKey: ['telegram-status'] })
      toast.success('Full diagnostic completed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Diagnostic failed')
    } finally {
      setRunningFull(false)
    }
  }

  async function retryAllFailed() {
    setRetrying(true)
    try {
      const res = await api<{ retried: number }>('/api/dashboard/diagnostics/queue/retry', { method: 'POST' })
      toast.success(`Re-queued ${res.retried} failed operation${res.retried === 1 ? '' : 's'}`)
      refetchQueue()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetrying(false)
    }
  }

  const components = health?.components
  const overall = health?.status ?? 'unhealthy'

  return (
    <div>
      <PageHeader
        title="Diagnostics"
        description="System health, pending durable writes, failed operations, and recent activity."
      />

      <div className="space-y-4 max-w-4xl">
        {/* Overall status + actions */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="flex items-center gap-3 mb-4">
            <Activity className="size-4 text-primary" />
            <h3 className="text-sm font-medium">System Status</h3>
            <Badge
              variant="outline"
              className={`ml-auto font-mono text-[10px] border-current/30 ${
                overall === 'healthy' ? 'text-emerald-600' : overall === 'degraded' ? 'text-amber-600' : 'text-red-600'
              }`}
            >
              {overall.toUpperCase()}
            </Badge>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <ComponentTile label="API" status={components?.api ?? 'unhealthy'} detail={health?.details.api} icon={Server} />
            <ComponentTile label="Database" status={components?.database ?? 'unhealthy'} detail={health?.details.database} icon={Database} />
            <ComponentTile label="Telegram" status={components?.telegram ?? 'unhealthy'} detail={health?.details.telegram} icon={Send} />
            <ComponentTile label="Realtime" status={components?.realtime ?? 'unhealthy'} detail={health?.details.realtime} icon={Wifi} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => refetchHealth()} disabled={healthFetching}>
              {healthFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh status
            </Button>
            <Button size="sm" onClick={runFullDiagnostic} disabled={runningFull}>
              {runningFull ? <Loader2 className="size-4 animate-spin" /> : <Heart className="size-4" />}
              Run full diagnostic
            </Button>
            {health?.requestId && (
              <span className="text-[10px] text-muted-foreground/60 font-mono ml-auto self-center">
                last check req: {health.requestId}
              </span>
            )}
          </div>
        </Card>

        {/* Storage queue */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="flex items-center gap-3 mb-4">
            <Database className="size-4 text-primary" />
            <h3 className="text-sm font-medium">Durable Write Queue</h3>
            <div className="ml-auto flex items-center gap-2">
              {queue && queue.failed > 0 && (
                <Button size="sm" variant="outline" onClick={retryAllFailed} disabled={retrying} className="text-xs h-7">
                  {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                  Retry all failed ({queue.failed})
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => refetchQueue()} className="text-xs h-7">
                <RefreshCw className="size-3" />
              </Button>
            </div>
          </div>

          {!queue ? (
            <div className="text-xs text-muted-foreground py-8 text-center">
              <Loader2 className="size-5 animate-spin mx-auto mb-2" />
              Loading queue state…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <QueueStat label="Pending" value={queue.pending} icon={Clock} color="text-amber-600" />
                <QueueStat label="In flight" value={queue.inFlight} icon={Loader2} color="text-blue-600" />
                <QueueStat label="Durable" value={queue.durable} icon={CheckCircle2} color="text-emerald-600" />
                <QueueStat label="Failed" value={queue.failed} icon={XCircle} color="text-red-600" />
              </div>

              {queue.operations.length === 0 ? (
                <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border/40 rounded-md">
                  No operations in the queue. Every write is durably mirrored.
                </div>
              ) : (
                <div className="rounded-md border border-border/40 divide-y divide-border/30 max-h-96 overflow-y-auto">
                  {queue.operations
                    .filter((op) => op.status !== 'durable')
                    .slice(0, 50)
                    .map((op) => (
                      <div key={op.id} className="p-3 text-xs flex items-start gap-3">
                        <div className="font-mono text-[10px] text-muted-foreground mt-0.5 w-16 shrink-0">
                          {op.operation}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <code className="font-mono text-[11px] truncate">
                              {op.collection}/{op.key || '—'}
                            </code>
                            <Badge
                              variant="outline"
                              className={`text-[9px] font-mono ${
                                op.status === 'failed'
                                  ? 'border-red-400/30 text-red-600'
                                  : op.status === 'retrying'
                                    ? 'border-amber-400/30 text-amber-600'
                                    : op.status === 'pending'
                                      ? 'border-blue-400/30 text-blue-600'
                                      : 'border-border/40 text-muted-foreground'
                              }`}
                            >
                              {op.status}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              attempt {op.attempts}/{op.maxAttempts}
                            </span>
                          </div>
                          {op.lastError && (
                            <p className="text-[10px] text-red-600/80 break-all font-mono">{op.lastError}</p>
                          )}
                          {op.status === 'retrying' && op.nextAttemptAt && (
                            <p className="text-[10px] text-muted-foreground">
                              next retry in {Math.max(0, Math.ceil((op.nextAttemptAt - Date.now()) / 1000))}s
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </Card>

        {/* Last refresh timestamp */}
        {health?.timestamp && (
          <p className="text-[10px] text-muted-foreground/60 text-right">
            Last health check: {new Date(health.timestamp).toLocaleString()} ({health.elapsedMs}ms)
          </p>
        )}
      </div>
    </div>
  )
}

function ComponentTile({
  label,
  status,
  detail,
  icon: Icon,
}: {
  label: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  detail?: string
  icon: typeof Server
}) {
  const meta = STATUS_META[status]
  const StatusIcon = meta.icon
  return (
    <div className={`rounded-md border border-border/40 ${meta.bg} p-3`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <StatusIcon className={`size-3.5 ml-auto ${meta.color}`} />
      </div>
      <div className={`text-xs font-medium ${meta.color}`}>{meta.label}</div>
      {detail && <p className="text-[10px] text-muted-foreground/80 mt-1 truncate">{detail}</p>}
    </div>
  )
}

function QueueStat({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string
  value: number
  icon: typeof Clock
  color: string
}) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`size-3.5 ${color}`} />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <div className={`text-xl font-mono font-medium ${color}`}>{value}</div>
    </div>
  )
}
