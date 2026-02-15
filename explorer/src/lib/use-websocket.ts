'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { WS_URL } from './provider'

interface WsRpcResponse {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { code: number; message: string }
  method?: string
  params?: { subscription: string; result: unknown }
}

const BASE_RECONNECT_MS = 1000
const MAX_RECONNECT_MS = 30000

/**
 * Hook for WebSocket JSON-RPC subscriptions.
 * Manages connection lifecycle, exponential backoff reconnection,
 * and subscription tracking.
 */
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const subsRef = useRef<Map<string, (data: unknown) => void>>(new Map())
  const pendingRef = useRef<Map<number, (result: unknown) => void>>(new Map())
  const nextIdRef = useRef(1)
  const [connected, setConnected] = useState(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backoffRef = useRef(BASE_RECONNECT_MS)
  const mountedRef = useRef(true)

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return
    const delay = backoffRef.current
    // Exponential backoff with jitter
    backoffRef.current = Math.min(delay * 2, MAX_RECONNECT_MS)
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connect()
    }, delay + Math.random() * 500)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return

    try {
      const ws = new WebSocket(WS_URL)

      ws.onopen = () => {
        backoffRef.current = BASE_RECONNECT_MS // Reset backoff on success
        setConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const msg: WsRpcResponse = JSON.parse(event.data)

          // Subscription notification
          if (msg.method === 'eth_subscription' && msg.params) {
            const handler = subsRef.current.get(msg.params.subscription)
            if (handler) handler(msg.params.result)
            return
          }

          // RPC response
          if (msg.id !== undefined) {
            const resolver = pendingRef.current.get(msg.id)
            if (resolver) {
              pendingRef.current.delete(msg.id)
              resolver(msg.result)
            }
          }
        } catch {
          // ignore parse errors
        }
      }

      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        // Clear stale subscriptions (server-side IDs are invalid after reconnect)
        subsRef.current.clear()
        scheduleReconnect()
      }

      ws.onerror = () => {
        ws.close()
      }

      wsRef.current = ws
    } catch {
      scheduleReconnect()
    }
  }, [scheduleReconnect])

  const sendRpc = useCallback((method: string, params: unknown[]): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'))
        return
      }
      const id = nextIdRef.current++
      pendingRef.current.set(id, resolve)
      wsRef.current.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))

      // Timeout after 10s
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id)
          reject(new Error('RPC timeout'))
        }
      }, 10000)
    })
  }, [])

  const subscribe = useCallback(async (
    subType: string,
    params: unknown[],
    onNotification: (data: unknown) => void,
  ): Promise<string | null> => {
    try {
      const subId = await sendRpc('eth_subscribe', [subType, ...params]) as string
      if (subId) {
        subsRef.current.set(subId, onNotification)
      }
      return subId
    } catch {
      return null
    }
  }, [sendRpc])

  const unsubscribe = useCallback(async (subId: string) => {
    subsRef.current.delete(subId)
    try {
      await sendRpc('eth_unsubscribe', [subId])
    } catch {
      // ignore
    }
  }, [sendRpc])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { connected, subscribe, unsubscribe, sendRpc }
}
