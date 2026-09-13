'use client'

import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useOnyxBase } from '@/lib/store'
import { useQueryClient } from '@tanstack/react-query'

/**
 * Subscribe to realtime record:changed events for the logged-in developer.
 * On any event we invalidate the relevant dashboard queries so the UI
 * refreshes from the authenticated REST API (the WS is notification-only).
 */
export function useRealtime() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const userId = useOnyxBase((s) => s.user?.userId)
  const setRealtimeConnected = useOnyxBase((s) => s.setRealtimeConnected)
  const qc = useQueryClient()
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!apiKey || !userId) return

    // path '/' + XTransformPort=3003 so Caddy forwards to the WS mini-service.
    // Polling first is the socket.io default and is the most proxy-friendly
    // transport (works behind the Caddy gateway); it then upgrades to websocket.
    const socket = io('/?XTransformPort=3003', {
      path: '/',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setRealtimeConnected(true)
      socket.emit('subscribe', { userId })
    })
    socket.on('disconnect', () => setRealtimeConnected(false))
    socket.on('reconnect', () => setRealtimeConnected(true))
    socket.on('record:changed', () => {
      qc.invalidateQueries({ queryKey: ['records'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['logs'] })
      qc.invalidateQueries({ queryKey: ['analytics'] })
      qc.invalidateQueries({ queryKey: ['collections'] })
    })
    // connect_error is expected during transient network blips — keep it quiet.

    return () => {
      socket.disconnect()
      socketRef.current = null
      setRealtimeConnected(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, userId])

  return socketRef.current
}
