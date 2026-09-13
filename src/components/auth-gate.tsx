'use client'

import { useEffect, useState } from 'react'
import { useOnyxBase } from '@/lib/store'
import { api } from '@/lib/api'
import { LoginScreen } from '@/components/login-screen'
import { DashboardShell } from '@/components/dashboard/shell'
import { AdminDashboard } from '@/components/admin/admin-dashboard'
import { Loader2 } from 'lucide-react'

/** Decides between the login screen and the dashboard. */
export function AuthGate() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const user = useOnyxBase((s) => s.user)
  const useAdminMode = useOnyxBase((s) => s.useAdminMode)
  const setSession = useOnyxBase((s) => s.setSession)
  const clearSession = useOnyxBase((s) => s.clearSession)
  const [bootstrapping, setBootstrapping] = useState(true)

  // On first load, if we have a persisted apiKey, re-validate it via /whoami.
  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      if (!apiKey) {
        setBootstrapping(false)
        return
      }
      try {
        const res = await api<{
          userId: string
          name: string | null
          plan: string
          apiKeyName: string
          isAdmin?: boolean
        }>('/api/auth/whoami', { method: 'GET', apiKey })
        if (cancelled) return
        const isAdmin = !!res.isAdmin
        if (user) {
          // refresh identity fields but keep counts
          setSession(apiKey, {
            ...user,
            userId: res.userId,
            name: res.name,
            plan: res.plan,
            apiKeyName: res.apiKeyName,
            isAdmin,
          })
        } else {
          setSession(apiKey, {
            userId: res.userId,
            name: res.name,
            plan: res.plan,
            apiKeyName: res.apiKeyName,
            createdAt: new Date().toISOString(),
            counts: { records: 0, collections: 0, apiKeys: 0, logs: 0 },
            isAdmin,
          })
        }
      } catch {
        if (!cancelled) clearSession()
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    }
    bootstrap()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (bootstrapping) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    )
  }

  if (!apiKey || !user) return <LoginScreen />

  // Admins can toggle between the admin dashboard and the regular dashboard.
  // Regular users always see the regular dashboard.
  if (user.isAdmin && useAdminMode) {
    return <AdminDashboard />
  }

  return <DashboardShell />
}
