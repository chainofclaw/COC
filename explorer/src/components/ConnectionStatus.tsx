'use client'

import { useWebSocket } from '@/lib/use-websocket'

/**
 * Small indicator showing WebSocket connection status in the header.
 */
export function ConnectionStatus() {
  const { connected } = useWebSocket()

  return (
    <div className="flex items-center space-x-2 text-sm">
      <div
        className={`w-2 h-2 rounded-full ${
          connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'
        }`}
      />
      <span className={connected ? 'text-green-200' : 'text-red-200'}>
        {connected ? 'Live' : 'Offline'}
      </span>
    </div>
  )
}
