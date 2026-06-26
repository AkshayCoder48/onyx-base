'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ViewKey =
  | 'overview'
  | 'database'
  | 'collections'
  | 'storage'
  | 'api-keys'
  | 'share'
  | 'logs'
  | 'analytics'
  | 'playground'
  | 'docs'
  | 'settings'

export interface SessionUser {
  userId: string
  name: string | null
  plan: string
  apiKeyName: string
  createdAt: string
  counts: { records: number; collections: number; apiKeys: number; logs: number }
}

interface OnyxBaseState {
  apiKey: string | null
  user: SessionUser | null
  activeView: ViewKey
  activeCollection: string
  realtimeConnected: boolean
  setSession: (apiKey: string, user: SessionUser) => void
  clearSession: () => void
  setUser: (user: SessionUser) => void
  setView: (view: ViewKey) => void
  setCollection: (name: string) => void
  setRealtimeConnected: (v: boolean) => void
}

export const useOnyxBase = create<OnyxBaseState>()(
  persist(
    (set) => ({
      apiKey: null,
      user: null,
      activeView: 'overview',
      activeCollection: 'default',
      realtimeConnected: false,
      setSession: (apiKey, user) => set({ apiKey, user }),
      clearSession: () => set({ apiKey: null, user: null, activeView: 'overview', activeCollection: 'default', realtimeConnected: false }),
      setUser: (user) => set({ user }),
      setView: (view) => set({ activeView: view }),
      setCollection: (name) => set({ activeCollection: name }),
      setRealtimeConnected: (v) => set({ realtimeConnected: v }),
    }),
    {
      name: 'cloudkv-session',
      partialize: (s) => ({ apiKey: s.apiKey, user: s.user, activeView: s.activeView, activeCollection: s.activeCollection }),
    },
  ),
)
