'use client'

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useOnyxBase } from '@/lib/store'

/**
 * Watches the active session's `apiKey` and clears the ENTIRE React Query
 * cache whenever it changes BETWEEN TWO NON-NULL values (i.e. a real session
 * switch: user A → user B, or user → admin, or admin → user).
 *
 * We deliberately do NOT clear on the very first mount (null → key) — that
 * would nuke the initial queries the dashboard fires on first render, causing
 * them to refetch and show empty/loading state for a moment. The cache is
 * already empty on a fresh page load, so there's nothing to clear anyway.
 *
 * The classic bug this fixes: user A signs out and user B signs in on the
 * same browser. Without this guard, user B briefly sees user A's records /
 * API keys / logs / files until each query refetches — because the cached
 * results are keyed only by the query key (e.g. `['api-keys']`), not by the
 * user. Clearing the cache on a real session switch guarantees user B starts
 * with a clean slate.
 */
function SessionCacheGuard({ children }: { children: ReactNode }) {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const qc = useQueryClient()
  // Track the previous apiKey. Initial value = the apiKey at first mount so
  // the effect does NOT fire on the very first render.
  const prevKey = useRef<string | null>(apiKey)

  useEffect(() => {
    // Only clear when transitioning from one real key to a DIFFERENT real key
    // (or from a real key back to null on sign-out). Skip the initial
    // null→key transition on first mount.
    if (prevKey.current !== apiKey) {
      const previous = prevKey.current
      prevKey.current = apiKey
      // Clear on: (a) key → different key (user switch), (b) key → null (sign out).
      // Skip: null → key (first sign-in on a fresh page load — nothing stale to clear).
      if (previous !== null) {
        qc.clear()
      }
    }
  }, [apiKey, qc])

  return <>{children}</>
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )
  return (
    <QueryClientProvider client={client}>
      <SessionCacheGuard>{children}</SessionCacheGuard>
    </QueryClientProvider>
  )
}
