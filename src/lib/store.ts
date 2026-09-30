'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ViewKey =
  | 'assistant'
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
      version: 3,
      // Migrations:
      //   v1 → v2: the retired 'email-otp' view moves to Email Automation.
      //   v2 → v3: the SQLite SQL workspace (SQL Editor + Tables tabs) was
      //            removed — those tabs land on the KV Database tab so a
      //            stale persisted tab can never blank the dashboard.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>
        if (version < 2 && state.activeView === 'email-otp') {
          state.activeView = 'email-automation'
        }
        if (version < 3 && (state.activeView === 'sql' || state.activeView === 'tables')) {
          state.activeView = 'database'
        }
        if (state.activeView !== undefined && ![
          'assistant', 'overview', 'database', 'collections', 'storage', 'api-keys',
          'email-automation', 'share', 'logs', 'analytics', 'playground',
          'docs', 'settings', 'diagnostics',
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
