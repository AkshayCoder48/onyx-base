'use client'

import { useEffect, useState } from 'react'
import { useOnyxBase } from '@/lib/store'
import { api } from '@/lib/api'
import { LoginScreen } from '@/components/login-screen'
import { AdminDashboard } from '@/components/admin/admin-dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ShieldAlert, ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'

/**
 * /admin route — direct URL access to the admin dashboard.
 *
 * Flow:
 *   - No session → LoginScreen (with a hint that an admin key is required)
 *   - Session but isAdmin=false → UnauthorizedScreen
 *   - Session + isAdmin=true → AdminDashboard
 *
 * Mirrors AuthGate's bootstrap (re-validates the persisted apiKey via /whoami
 * so we pick up the latest isAdmin flag).
 */
export default function AdminPage() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const user = useOnyxBase((s) => s.user)
  const setSession = useOnyxBase((s) => s.setSession)
  const clearSession = useOnyxBase((s) => s.clearSession)
  const setAdminMode = useOnyxBase((s) => s.setAdminMode)
  const [bootstrapping, setBootstrapping] = useState(true)

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
        // Force admin mode on when navigating directly to /admin.
        if (isAdmin) setAdminMode(true)
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

  if (!user.isAdmin) {
    return <UnauthorizedScreen />
  }

  return <AdminDashboard />
}

function UnauthorizedScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-md w-full p-8 text-center bg-card/40 border-border/60">
        <div className="size-14 rounded-xl bg-red-500/10 border border-red-500/20 grid place-items-center mx-auto mb-4">
          <ShieldAlert className="size-7 text-red-600" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Unauthorized</h1>
        <p className="text-sm text-muted-foreground mb-6">
          An <code className="font-mono text-foreground/80">onyxbase_…</code> admin key is required to
          access this page. Your current session is a regular developer account.
        </p>
        <Link href="/">
          <Button variant="outline" className="w-full">
            <ArrowLeft className="size-4" /> Back to dashboard
          </Button>
        </Link>
      </Card>
    </div>
  )
}
