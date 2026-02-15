'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useWebSocket } from '@/lib/use-websocket'
import { formatHash } from '@/lib/provider'

interface BlockHeader {
  number: string
  hash: string
  parentHash: string
  timestamp: string
  gasUsed: string
  gasLimit: string
  transactionsRoot: string
}

const MAX_LIVE_BLOCKS = 10

/**
 * Displays real-time block updates via WebSocket subscription.
 */
export function LiveBlocks() {
  const { connected, subscribe, unsubscribe } = useWebSocket()
  const [blocks, setBlocks] = useState<BlockHeader[]>([])
  const subIdRef = useRef<string | null>(null)

  const handleNewBlock = useCallback((data: unknown) => {
    const block = data as BlockHeader
    setBlocks(prev => {
      const updated = [block, ...prev]
      return updated.slice(0, MAX_LIVE_BLOCKS)
    })
  }, [])

  useEffect(() => {
    if (!connected) return

    subscribe('newHeads', [], handleNewBlock).then(id => {
      subIdRef.current = id
    })

    return () => {
      if (subIdRef.current) {
        void unsubscribe(subIdRef.current)
        subIdRef.current = null
      }
    }
  }, [connected, subscribe, unsubscribe, handleNewBlock])

  if (!connected) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
          <span className="text-sm text-yellow-700">Connecting to WebSocket...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Real-time Blocks</h2>
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <span className="text-sm text-green-600">Live</span>
        </div>
      </div>

      {blocks.length === 0 ? (
        <p className="text-gray-500 text-sm">Waiting for new blocks...</p>
      ) : (
        <div className="space-y-2">
          {blocks.map((block) => {
            const blockNum = parseInt(block.number, 16)
            const time = new Date(parseInt(block.timestamp, 16) * 1000)
            const gasUsed = parseInt(block.gasUsed, 16)
            return (
              <div
                key={block.hash}
                className="flex items-center justify-between bg-gray-50 rounded p-3 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center space-x-4">
                  <Link
                    href={`/block/${blockNum}`}
                    className="text-blue-600 hover:text-blue-800 font-mono font-bold"
                  >
                    #{blockNum}
                  </Link>
                  <span className="font-mono text-sm text-gray-500">
                    {formatHash(block.hash)}
                  </span>
                </div>
                <div className="flex items-center space-x-4 text-sm text-gray-600">
                  <span>Gas: {gasUsed.toLocaleString()}</span>
                  <span>{time.toLocaleTimeString('zh-CN')}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
