'use client'

import { useOnyxBase } from '@/lib/store'
import { useRealtime } from '@/lib/useRealtime'

/** Tiny live indicator that pulses green when the realtime socket is connected. */
export function RealtimeIndicator() {
  // subscribe so the socket stays alive for the whole dashboard session
  useRealtime()
  const connected = useOnyxBase((s) => s.realtimeConnected)

  return (
    <span
      title={connected ? 'Realtime connected' : 'Realtime offline'}
      className={`size-1.5 rounded-full ${connected ? 'bg-primary pulse-dot' : 'bg-muted-foreground/40'}`}
    />
  )
}
