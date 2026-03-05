'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations()
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
          <div key={i} className="bg-bg-elevated rounded-lg border border-text-muted/10 p-4 animate-pulse">
            <div className="h-4 bg-text-muted/20 rounded w-20 mb-2"></div>
            <div className="h-6 bg-text-muted/30 rounded w-24"></div>
          </div>
        ))}
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="bg-red-950/20 border border-red-500/30 rounded-lg p-4 text-red-400">
        {t('network.error') || '无法连接到COC网络节点'}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      <StatCard label={t('network.blockHeight')} value={stats.blockNumber.toLocaleString()} />
      <StatCard
        label={t('network.avgBlockTime')}
        value={stats.avgBlockTime > 0 ? `${(stats.avgBlockTime / 1000).toFixed(1)}s` : 'N/A'}
      />
      <StatCard label={t('network.gasPrice')} value={`${Number(stats.gasPrice) / 1e9} Gwei`} />
      <StatCard label={t('network.chainId')} value={stats.chainId.toString()} />
      <StatCard label={t('network.peers')} value={stats.peerCount.toString()} />
      <StatCard
        label={t('network.syncStatus')}
        value={stats.syncing ? t('network.syncing') : t('network.synced')}
        valueClass={stats.syncing ? 'text-yellow-500' : 'text-green-500'}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  valueClass = 'text-text-primary',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="bg-bg-elevated rounded-lg border border-text-muted/10 p-4 hover:border-accent-cyan/30 transition-all duration-300 hover:shadow-glow-sm">
      <div className="text-xs font-display font-semibold text-text-muted uppercase mb-2">{label}</div>
      <div className={`text-xl font-bold ${valueClass}`}>{value}</div>
    </div>
  )
}
