'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useWebSocket } from '@/lib/use-websocket'
import { formatHash } from '@/lib/provider'

const MAX_PENDING_TXS = 20

/**
 * Displays real-time pending transaction hashes via WebSocket subscription.
 */
export function LiveTransactions() {
  const { connected, subscribe, unsubscribe } = useWebSocket()
  const [txHashes, setTxHashes] = useState<string[]>([])
  const subIdRef = useRef<string | null>(null)

  const handleNewTx = useCallback((data: unknown) => {
    const txHash = data as string
    setTxHashes(prev => {
      const updated = [txHash, ...prev.filter(h => h !== txHash)]
      return updated.slice(0, MAX_PENDING_TXS)
    })
  }, [])

  useEffect(() => {
    if (!connected) return

    subscribe('newPendingTransactions', [], handleNewTx).then(id => {
      subIdRef.current = id
    })

    return () => {
      if (subIdRef.current) {
        void unsubscribe(subIdRef.current)
        subIdRef.current = null
      }
    }
  }, [connected, subscribe, unsubscribe, handleNewTx])

  if (!connected) {
    return null
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Pending Transactions</h2>
        <span className="text-sm text-gray-500">{txHashes.length} txs</span>
      </div>

      {txHashes.length === 0 ? (
        <p className="text-gray-500 text-sm">No pending transactions</p>
      ) : (
        <div className="space-y-1">
          {txHashes.map((hash) => (
            <div
              key={hash}
              className="flex items-center bg-gray-50 rounded p-2 hover:bg-gray-100 transition-colors"
            >
              <Link
                href={`/tx/${hash}`}
                className="text-blue-600 hover:text-blue-800 font-mono text-sm"
              >
                {formatHash(hash)}
              </Link>
              <span className="ml-2 px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded">
                pending
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
