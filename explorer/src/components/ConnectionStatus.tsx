'use client'

import { useWebSocket } from '@/lib/use-websocket'

/**
 * Small indicator showing WebSocket connection status in the header.
 * Shows reconnection attempt count during backoff.
 */
export function ConnectionStatus() {
  const { connected, reconnecting, reconnectAttempt } = useWebSocket()

  if (connected) {
    return (
      <div className="flex items-center space-x-2 text-sm">
        <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
        <span className="text-green-200">Live</span>
      </div>
    )
  }

  if (reconnecting) {
    return (
      <div className="flex items-center space-x-2 text-sm">
        <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
        <span className="text-yellow-200">
          Reconnecting{reconnectAttempt > 1 ? ` (${reconnectAttempt})` : '...'}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center space-x-2 text-sm">
      <div className="w-2 h-2 rounded-full bg-red-400" />
      <span className="text-red-200">Offline</span>
    </div>
  )
}
