'use client'

import { useEffect, useState } from 'react'

interface BlockStat {
  number: number
  txCount: number
  gasUsed: number
  gasLimit: number
  timestamp: number
}

interface ChainChartsProps {
  rpcUrl: string
}

export default function ChainCharts({ rpcUrl }: ChainChartsProps) {
  const [blocks, setBlocks] = useState<BlockStat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        })
        const { result: hexHeight } = await res.json()
        const height = parseInt(hexHeight, 16)

        const startBlock = Math.max(1, height - 99) // Last 100 blocks
        const blockData: BlockStat[] = []

        // Fetch blocks in batches of 10
        for (let i = startBlock; i <= height; i += 10) {
          const batch = []
          for (let j = i; j < Math.min(i + 10, height + 1); j++) {
            batch.push(
              fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: j,
                  method: 'eth_getBlockByNumber',
                  params: [`0x${j.toString(16)}`, false],
                }),
              }).then(r => r.json())
            )
          }
          const results = await Promise.all(batch)
          for (const r of results) {
            if (r.result) {
              const b = r.result
              blockData.push({
                number: parseInt(b.number, 16),
                txCount: Array.isArray(b.transactions) ? b.transactions.length : 0,
                gasUsed: parseInt(b.gasUsed || '0x0', 16),
                gasLimit: parseInt(b.gasLimit || '0x1c9c380', 16), // 30M default
                timestamp: parseInt(b.timestamp || '0x0', 16),
              })
            }
          }
        }

        setBlocks(blockData.sort((a, b) => a.number - b.number))
      } catch {
        // Silently fail — charts are non-critical
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [rpcUrl])

  if (loading) {
    return <div className="text-gray-500 text-sm">Loading chart data...</div>
  }

  if (blocks.length < 2) {
    return <div className="text-gray-500 text-sm">Not enough blocks for charts</div>
  }

  // Compute TPS for each block pair
  const tpsData = blocks.slice(1).map((block, i) => {
    const prev = blocks[i]
    const timeDiff = block.timestamp - prev.timestamp
    const tps = timeDiff > 0 ? block.txCount / timeDiff : 0
    return { number: block.number, tps: Math.round(tps * 100) / 100 }
  })

  const maxTps = Math.max(...tpsData.map(d => d.tps), 1)
  const maxGas = Math.max(...blocks.map(b => b.gasUsed), 1)

  return (
    <div className="space-y-6">
      {/* TPS Trend */}
      <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="text-sm font-medium text-gray-700 mb-3">TPS Trend (Last {tpsData.length} blocks)</h3>
        <div className="flex items-end gap-px h-32">
          {tpsData.map(d => (
            <div
              key={d.number}
              className="flex-1 bg-blue-500 rounded-t hover:bg-blue-600 transition-colors"
              style={{ height: `${(d.tps / maxTps) * 100}%`, minHeight: '2px' }}
              title={`Block ${d.number}: ${d.tps} TPS`}
            />
          ))}
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>Block {tpsData[0]?.number}</span>
          <span>Block {tpsData[tpsData.length - 1]?.number}</span>
        </div>
      </div>

      {/* Gas Usage */}
      <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Gas Usage (Last {blocks.length} blocks)</h3>
        <div className="flex items-end gap-px h-32">
          {blocks.map(b => {
            const pct = b.gasLimit > 0 ? (b.gasUsed / b.gasLimit) * 100 : 0
            return (
              <div
                key={b.number}
                className={`flex-1 rounded-t transition-colors ${pct > 80 ? 'bg-red-500 hover:bg-red-600' : pct > 50 ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-green-500 hover:bg-green-600'}`}
                style={{ height: `${Math.max((b.gasUsed / maxGas) * 100, 2)}%` }}
                title={`Block ${b.number}: ${b.gasUsed.toLocaleString()} gas (${Math.round(pct)}%)`}
              />
            )
          })}
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>Block {blocks[0]?.number}</span>
          <span>Block {blocks[blocks.length - 1]?.number}</span>
        </div>
      </div>
    </div>
  )
}
