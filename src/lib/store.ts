'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ViewKey =
  | 'overview'
  | 'database'
  | 'collections'
  | 'storage'
  | 'api-keys'
  | 'email-automation'
  | 'share'
  | 'logs'
  | 'analytics'
  | 'playground'
  | 'sql'
  | 'tables'
  | 'docs'
  | 'settings'
  | 'diagnostics'

export interface SessionUser {
  userId: string
  name: string | null
  plan: string
  apiKeyName: string
  createdAt: string
  counts: { records: number; collections: number; apiKeys: number; logs: number }
  /** True when authenticated via an `onyxbase_*` admin key. */
  isAdmin?: boolean
}

interface OnyxBaseState {
  apiKey: string | null
  user: SessionUser | null
  activeView: ViewKey
  activeCollection: string
  realtimeConnected: boolean
  /** When true AND user.isAdmin, the admin dashboard is shown instead of the regular dashboard. */
  useAdminMode: boolean
  setSession: (apiKey: string, user: SessionUser) => void
  clearSession: () => void
  setUser: (user: SessionUser) => void
  setView: (view: ViewKey) => void
  setCollection: (name: string) => void
  setRealtimeConnected: (v: boolean) => void
  setAdminMode: (v: boolean) => void
}

export const useOnyxBase = create<OnyxBaseState>()(
  persist(
    (set) => ({
      apiKey: null,
      user: null,
      activeView: 'overview',
      activeCollection: 'default',
      realtimeConnected: false,
      useAdminMode: true,
      setSession: (apiKey, user) => set({ apiKey, user, useAdminMode: user.isAdmin ? true : false }),
      clearSession: () =>
        set({
          apiKey: null,
          user: null,
          activeView: 'overview',
          activeCollection: 'default',
          realtimeConnected: false,
          useAdminMode: true,
        }),
      setUser: (user) => set({ user }),
      setView: (view) => set({ activeView: view }),
      setCollection: (name) => set({ activeCollection: name }),
      setRealtimeConnected: (v) => set({ realtimeConnected: v }),
      setAdminMode: (v) => set({ useAdminMode: v }),
    }),
    {
      name: 'cloudkv-session',
      version: 2,
      // Migrate persisted sessions from the retired 'email-otp' view to the
      // new Email Automation tab (v1 → v2). Anything unrecognized falls back
      // to 'overview' so a stale tab can never blank the dashboard.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>
        if (version < 2 && state.activeView === 'email-otp') {
          state.activeView = 'email-automation'
        }
        if (state.activeView !== undefined && ![
          'overview', 'database', 'collections', 'storage', 'api-keys',
          'email-automation', 'share', 'logs', 'analytics', 'playground',
          'sql', 'tables', 'docs', 'settings', 'diagnostics',
        ].includes(state.activeView as string)) {
          state.activeView = 'overview'
        }
        return state as unknown as OnyxBaseState
      },
      partialize: (s) => ({
        apiKey: s.apiKey,
        user: s.user,
        activeView: s.activeView,
        activeCollection: s.activeCollection,
        useAdminMode: s.useAdminMode,
      }),
    },
  ),
)
