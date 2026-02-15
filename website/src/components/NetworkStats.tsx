'use client'

import { useEffect, useState } from 'react'
import { provider } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'

interface NetworkStats {
  blockNumber: number
  avgBlockTime: number
  gasPrice: bigint
  chainId: number
  peerCount: number
  syncing: boolean
}

export function NetworkStats() {
  const [stats, setStats] = useState<NetworkStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    async function fetchStats() {
      try {
        const [blockNumber, gasPrice, chainId, syncing, peerCount] = await Promise.all([
          provider.getBlockNumber(),
          rpcCall<string>('eth_gasPrice').catch(() => '0x0'),
          rpcCall<string>('eth_chainId').catch(() => '0x495c'),
          rpcCall<boolean>('eth_syncing').catch(() => false),
          rpcCall<string>('net_peerCount').catch(() => '0x0'),
        ])

        // Calculate avg block time
        let avgBlockTime = 0
        if (blockNumber > 1) {
          const count = Math.min(10, blockNumber)
          const [newest, oldest] = await Promise.all([
            provider.getBlock(blockNumber),
            provider.getBlock(blockNumber - count + 1),
          ])
          if (newest && oldest && newest.timestamp > oldest.timestamp) {
            avgBlockTime = ((newest.timestamp - oldest.timestamp) * 1000) / (count - 1)
          }
        }

        if (mounted) {
          setStats({
            blockNumber,
            avgBlockTime,
            gasPrice: BigInt(gasPrice),
            chainId: parseInt(chainId, 16),
            peerCount: parseInt(peerCount, 16),
            syncing,
          })
          setLoading(false)
        }
      } catch (error) {
        console.error('Failed to fetch network stats:', error)
        if (mounted) setLoading(false)
      }
    }

    fetchStats()
    const interval = setInterval(fetchStats, 5000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-white rounded-lg shadow p-4 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-20 mb-2"></div>
            <div className="h-6 bg-gray-300 rounded w-24"></div>
          </div>
        ))}
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        无法连接到COC网络节点
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      <StatCard label="区块高度" value={stats.blockNumber.toLocaleString()} />
      <StatCard
        label="平均出块时间"
        value={stats.avgBlockTime > 0 ? `${(stats.avgBlockTime / 1000).toFixed(1)}s` : 'N/A'}
      />
      <StatCard label="Gas价格" value={`${Number(stats.gasPrice) / 1e9} Gwei`} />
      <StatCard label="链ID" value={stats.chainId.toString()} />
      <StatCard label="连接节点" value={stats.peerCount.toString()} />
      <StatCard
        label="同步状态"
        value={stats.syncing ? '同步中' : '已同步'}
        valueClass={stats.syncing ? 'text-yellow-600' : 'text-green-600'}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  valueClass = 'text-gray-900',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="bg-white rounded-lg shadow p-4 border border-gray-100">
      <div className="text-xs font-medium text-gray-500 uppercase mb-1">{label}</div>
      <div className={`text-xl font-bold ${valueClass}`}>{value}</div>
    </div>
  )
}
