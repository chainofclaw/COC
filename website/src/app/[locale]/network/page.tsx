'use client'

import { NetworkStats } from '@/components/NetworkStats'
import { provider } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

// Moved to client component for consistency with design system

type NodeInfo = {
  runtime: string
  version: string
  startTime: number
  uptime: number
  endpoints: {
    rpc: string
    ws: string
    p2p: string
  }
} | null

type Validator = {
  address: string
  score: number
  blocks: number
}

type BlockData = {
  number: number
  timestamp: number
  transactions: string[]
  gasUsed?: bigint
}

type ChainStats = {
  blockHeight: string
  blocksPerMinute: number
  pendingTxCount: number
  recentTxCount: number
  validatorCount: number
  chainId: string
  latestBlockTime: number
}

type BftStatus = {
  enabled: boolean
  active?: boolean
  height?: string
  phase?: string
  prepareVotes?: number
  commitVotes?: number
  equivocations?: number
}

type NetworkStats = {
  blockHeight: string
  peerCount: number
  p2p?: {
    peers: number
    protocol: string
    security?: {
      rateLimitedRequests: number
      authAcceptedRequests: number
      authInvalidRequests: number
    }
  }
  wire?: {
    enabled: boolean
    peers?: number
  }
  dht?: {
    enabled: boolean
    nodes?: number
  }
  bft?: BftStatus
  consensus?: {
    state: string
  }
}

type MemPoolStatus = {
  pending: string
  queued: string
}

type DaoStats = {
  enabled: boolean
  activeValidators?: number
  totalStake?: string
  pendingProposals?: number
  totalProposals?: number
  currentEpoch?: string
  treasuryBalance?: string
}

export default function NetworkPage() {
  const t = useTranslations('network')
  const [nodeInfo, setNodeInfo] = useState<NodeInfo>(null)
  const [validators, setValidators] = useState<Validator[]>([])
  const [recentBlocks, setRecentBlocks] = useState<BlockData[]>([])
  const [avgBlockTime, setAvgBlockTime] = useState(0)
  const [avgTxCount, setAvgTxCount] = useState(0)
  const [avgGasUsed, setAvgGasUsed] = useState(0n)
  const [isLoading, setIsLoading] = useState(true)
  const [chainStats, setChainStats] = useState<ChainStats | null>(null)
  const [bftStatus, setBftStatus] = useState<BftStatus | null>(null)
  const [networkStats, setNetworkStats] = useState<NetworkStats | null>(null)
  const [memPoolStatus, setMemPoolStatus] = useState<MemPoolStatus | null>(null)
  const [daoStats, setDaoStats] = useState<DaoStats | null>(null)

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true)
      try {
        // Parallel fetch all RPC data
        const [
          info,
          vals,
          chainStatsData,
          bftStatusData,
          networkStatsData,
          memPoolStatusData,
          daoStatsData,
          blockNumber
        ] = await Promise.all([
          rpcCall<NodeInfo>('coc_nodeInfo').catch(() => null),
          rpcCall<Validator[]>('coc_validators').catch(() => []),
          rpcCall<ChainStats>('coc_chainStats').catch(() => null),
          rpcCall<BftStatus>('coc_getBftStatus').catch(() => null),
          rpcCall<NetworkStats>('coc_getNetworkStats').catch(() => null),
          rpcCall<MemPoolStatus>('txpool_status').catch(() => null),
          rpcCall<DaoStats>('coc_getDaoStats').catch(() => null),
          provider.getBlockNumber().catch(() => 0)
        ])

        setNodeInfo(info)
        setValidators(vals)
        setChainStats(chainStatsData)
        setBftStatus(bftStatusData)
        setNetworkStats(networkStatsData)
        setMemPoolStatus(memPoolStatusData)
        setDaoStats(daoStatsData)

        // Fetch recent blocks
        const count = Math.min(10, blockNumber + 1)
        const blocks = await Promise.all(
          Array.from({ length: count }, (_, i) => provider.getBlock(blockNumber - i))
        )
        const filteredBlocks = blocks.filter(Boolean) as unknown as BlockData[]
        setRecentBlocks(filteredBlocks)

        // Calculate stats
        if (filteredBlocks.length > 1) {
          const timestamps = filteredBlocks.map(b => b.timestamp)
          const timeDiffs = []
          for (let i = 0; i < timestamps.length - 1; i++) {
            timeDiffs.push(timestamps[i] - timestamps[i + 1])
          }
          setAvgBlockTime(timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length)
          setAvgTxCount(filteredBlocks.reduce((sum, b) => sum + b.transactions.length, 0) / filteredBlocks.length)
          setAvgGasUsed(filteredBlocks.reduce((sum, b) => sum + (b.gasUsed || 0n), 0n) / BigInt(filteredBlocks.length))
        }
      } catch (error) {
        console.error('Failed to fetch network data:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="relative min-h-screen">
      {/* Hero Header */}
      <section className="relative py-20 overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-bg-primary via-bg-secondary to-bg-primary">
          <div className="absolute inset-0 opacity-20">
            <div className="absolute top-10 left-10 w-96 h-96 bg-accent-cyan rounded-full blur-[100px] animate-pulse-slow" />
            <div className="absolute bottom-10 right-10 w-96 h-96 bg-accent-blue rounded-full blur-[100px] animate-pulse-slow delay-1000" />
          </div>
        </div>

        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-4xl mx-auto text-center">
            {/* Pre-title */}
            <div className="inline-block mb-6 fade-in">
              <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                <span className="font-display text-sm text-accent-cyan tracking-wider">
                  &gt; NETWORK_STATUS_MONITOR
                </span>
              </div>
            </div>

            <h1 className="text-4xl md:text-6xl font-display font-bold mb-4 fade-in-delay-1">
              <span className="gradient-text glow-text">{t('title')}</span>
            </h1>
            <p className="text-xl text-text-secondary font-body fade-in-delay-2">
              {t('subtitle')}
            </p>
          </div>
        </div>

        {/* Bottom Glow Line */}
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />
      </section>

      <div className="container mx-auto px-4 py-12">
        {/* Real-time Stats */}
        <section className="mb-16">
          <div className="text-center mb-8 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              <span className="gradient-text">{t('realTimeStats')}</span>
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="fade-in-delay-1">
            <NetworkStats />
          </div>
        </section>

        {/* Chain Statistics */}
        {!isLoading && chainStats && (
          <section className="mb-16 fade-in-up">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('chainStats.title')}
            </h2>
            <div className="grid md:grid-cols-5 gap-4">
              <StatMetricCard
                title={t('chainStats.blockHeight')}
                value={parseInt(chainStats.blockHeight, 16).toLocaleString()}
              />
              <StatMetricCard
                title={t('chainStats.blockRate')}
                value={`${chainStats.blocksPerMinute.toFixed(1)}`}
                unit="块/分钟"
              />
              <StatMetricCard
                title={t('chainStats.tps')}
                value={`${(chainStats.recentTxCount / 10 / 3).toFixed(2)}`}
                unit="tx/s"
              />
              <StatMetricCard
                title={t('chainStats.pendingTx')}
                value={chainStats.pendingTxCount.toString()}
              />
              <StatMetricCard
                title={t('chainStats.validatorCount')}
                value={chainStats.validatorCount.toString()}
              />
            </div>
          </section>
        )}

        {/* BFT Consensus Status */}
        {!isLoading && bftStatus && (
          <section className="mb-16 fade-in-delay-1">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('bftStatus.title')}
            </h2>
            <div className="bg-bg-elevated rounded-xl p-8 border border-text-muted/10 hover:border-accent-cyan/30 transition-all duration-500 shadow-glow-sm hover:shadow-glow-md noise-texture">
              <div className="grid md:grid-cols-2 gap-6">
                <InfoRow
                  label={t('bftStatus.enabled')}
                  value={bftStatus.enabled ? t('bftStatus.enabled') : t('bftStatus.disabled')}
                />
                {bftStatus.enabled && bftStatus.active !== undefined && (
                  <>
                    <InfoRow
                      label={t('bftStatus.active')}
                      value={bftStatus.active ? '活跃' : '非活跃'}
                    />
                    <InfoRow
                      label={t('bftStatus.phase')}
                      value={bftStatus.phase || 'N/A'}
                    />
                    <InfoRow
                      label={t('bftStatus.prepareVotes')}
                      value={bftStatus.prepareVotes?.toString() || '0'}
                    />
                    <InfoRow
                      label={t('bftStatus.commitVotes')}
                      value={bftStatus.commitVotes?.toString() || '0'}
                    />
                    <InfoRow
                      label={t('bftStatus.equivocations')}
                      value={bftStatus.equivocations?.toString() || '0'}
                    />
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Network Topology */}
        {!isLoading && networkStats && (
          <section className="mb-16 fade-in-delay-1">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('networkTopology.title')}
            </h2>
            <div className="grid md:grid-cols-4 gap-4">
              <StatMetricCard
                title={t('networkTopology.httpPeers')}
                value={networkStats.peerCount?.toString() || '0'}
              />
              <StatMetricCard
                title={t('networkTopology.wireConnections')}
                value={networkStats.wire?.peers?.toString() || '0'}
                status={networkStats.wire?.enabled ? 'enabled' : 'disabled'}
              />
              <StatMetricCard
                title={t('networkTopology.dhtNodes')}
                value={networkStats.dht?.nodes?.toString() || '0'}
                status={networkStats.dht?.enabled ? 'enabled' : 'disabled'}
              />
              <StatMetricCard
                title={t('networkTopology.securityMetrics')}
                value={`${networkStats.p2p?.security?.authAcceptedRequests || 0}`}
                unit="认证请求"
              />
            </div>
          </section>
        )}

        {/* Mempool Status */}
        {!isLoading && memPoolStatus && (
          <section className="mb-16 fade-in-delay-2">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('mempool.title')}
            </h2>
            <div className="grid md:grid-cols-3 gap-4">
              <StatMetricCard
                title={t('mempool.pending')}
                value={parseInt(memPoolStatus.pending, 16).toString()}
              />
              <StatMetricCard
                title={t('mempool.queued')}
                value={parseInt(memPoolStatus.queued, 16).toString()}
              />
              <StatMetricCard
                title={t('mempool.total')}
                value={(parseInt(memPoolStatus.pending, 16) + parseInt(memPoolStatus.queued, 16)).toString()}
              />
            </div>
          </section>
        )}

        {/* DAO Governance Stats */}
        {!isLoading && daoStats && daoStats.enabled && (
          <section className="mb-16 fade-in-delay-2">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('daoStats.title')}
            </h2>
            <div className="grid md:grid-cols-4 gap-4">
              <StatMetricCard
                title={t('daoStats.currentEpoch')}
                value={daoStats.currentEpoch ? parseInt(daoStats.currentEpoch, 16).toString() : '0'}
              />
              <StatMetricCard
                title={t('daoStats.activeValidators')}
                value={daoStats.activeValidators?.toString() || '0'}
              />
              <StatMetricCard
                title={t('daoStats.pendingProposals')}
                value={daoStats.pendingProposals?.toString() || '0'}
              />
              <StatMetricCard
                title={t('daoStats.treasuryBalance')}
                value={daoStats.treasuryBalance ? `${parseInt(daoStats.treasuryBalance, 16) / 1e18}` : '0'}
                unit="Token"
              />
            </div>
          </section>
        )}

        {/* Node Info */}
        {!isLoading && nodeInfo && (
          <section className="mb-16 fade-in-up">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('nodeInfo.title')}
            </h2>
            <div className="bg-bg-elevated rounded-xl p-8 border border-text-muted/10 hover:border-accent-cyan/30 transition-all duration-500 shadow-glow-sm hover:shadow-glow-md noise-texture">
              <div className="grid md:grid-cols-2 gap-6">
                <InfoRow label={t('nodeInfo.runtime')} value={nodeInfo.runtime} />
                <InfoRow label={t('nodeInfo.version')} value={nodeInfo.version} />
                <InfoRow
                  label={t('nodeInfo.startTime')}
                  value={new Date(nodeInfo.startTime).toLocaleString('zh-CN')}
                />
                <InfoRow
                  label={t('nodeInfo.uptime')}
                  value={formatUptime(nodeInfo.uptime)}
                />
                <InfoRow label={t('nodeInfo.rpcEndpoint')} value={nodeInfo.endpoints.rpc} mono />
                <InfoRow label={t('nodeInfo.wsEndpoint')} value={nodeInfo.endpoints.ws} mono />
                <InfoRow label={t('nodeInfo.p2pEndpoint')} value={nodeInfo.endpoints.p2p} mono />
              </div>
            </div>
          </section>
        )}

        {/* Performance Metrics */}
        {!isLoading && (
          <section className="mb-16 fade-in-delay-1">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('performanceMetrics.title')}
            </h2>
            <div className="grid md:grid-cols-3 gap-6">
              <MetricCard
                title={t('performanceMetrics.avgBlockTime')}
                value={avgBlockTime > 0 ? `${avgBlockTime.toFixed(2)}s` : 'N/A'}
                trend={avgBlockTime > 0 && avgBlockTime < 3 ? 'good' : 'neutral'}
              />
              <MetricCard
                title={t('performanceMetrics.avgTxPerBlock')}
                value={avgTxCount.toFixed(1)}
                trend="neutral"
              />
              <MetricCard
                title={t('performanceMetrics.avgGasUsed')}
                value={avgGasUsed.toString()}
                trend="neutral"
              />
            </div>
          </section>
        )}

        {/* Validators */}
        {!isLoading && validators.length > 0 && (
          <section className="mb-16 fade-in-delay-2">
            <h2 className="text-2xl md:text-3xl font-display font-bold mb-6 text-text-primary">
              {t('validators.title')}
            </h2>
            <div className="bg-bg-elevated rounded-xl overflow-hidden border border-text-muted/10 hover:border-accent-cyan/30 transition-all duration-500 shadow-glow-sm hover:shadow-glow-md">
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead className="bg-bg-secondary border-b border-text-muted/10">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('validators.address')}
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('validators.score')}
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('validators.blocks')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-text-muted/10">
                    {validators.map((v, idx) => (
                      <tr key={idx} className="group hover:bg-accent-cyan/5 transition-colors duration-300">
                        <td className="px-6 py-4 font-display text-sm text-accent-cyan group-hover:text-accent-blue transition-colors">
                          {v.address}
                        </td>
                        <td className="px-6 py-4 font-body text-text-secondary">
                          {v.score}
                        </td>
                        <td className="px-6 py-4 font-body text-text-secondary">
                          {v.blocks}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* Recent Blocks */}
        {!isLoading && (
          <section className="mb-16 fade-in-delay-3">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
              <h2 className="text-2xl md:text-3xl font-display font-bold text-text-primary">
                {t('recentBlocks.title')}
              </h2>
              <a
                href="http://localhost:3000"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 font-display text-accent-cyan hover:text-accent-blue transition-colors"
              >
                {t('recentBlocks.viewExplorer')}
                <svg
                  className="w-5 h-5 group-hover:translate-x-1 transition-transform"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </a>
            </div>
            <div className="bg-bg-elevated rounded-xl overflow-hidden border border-text-muted/10 hover:border-accent-cyan/30 transition-all duration-500 shadow-glow-sm hover:shadow-glow-md">
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead className="bg-bg-secondary border-b border-text-muted/10">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('recentBlocks.blockHeight')}
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('recentBlocks.timestamp')}
                      </th>
                      <th className="px-6 py-4 text-center text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('recentBlocks.txCount')}
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-display font-semibold text-text-muted uppercase tracking-wider">
                        {t('recentBlocks.gasUsed')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-text-muted/10">
                    {recentBlocks.map((block) => (
                      <tr key={block.number} className="group hover:bg-accent-cyan/5 transition-colors duration-300">
                        <td className="px-6 py-4 font-display text-sm">
                          <a
                            href={`http://localhost:3000/block/${block.number}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent-cyan hover:text-accent-blue transition-colors"
                          >
                            {block.number}
                          </a>
                        </td>
                        <td className="px-6 py-4 font-body text-sm text-text-secondary">
                          {new Date(block.timestamp * 1000).toLocaleString('zh-CN')}
                        </td>
                        <td className="px-6 py-4 text-center font-body text-text-secondary">
                          {block.transactions.length}
                        </td>
                        <td className="px-6 py-4 font-display text-sm text-text-secondary">
                          {block.gasUsed?.toString() || '0'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* Quick Links */}
        <section className="fade-in-delay-3">
          <div className="relative bg-gradient-to-br from-accent-cyan/10 via-accent-blue/10 to-accent-purple/10 rounded-xl p-8 border border-accent-cyan/20 noise-texture overflow-hidden">
            {/* Background Glow */}
            <div className="absolute inset-0 bg-gradient-cyber opacity-5" />

            <div className="relative z-10">
              <h3 className="text-xl md:text-2xl font-display font-bold text-text-primary mb-6">
                {t('quickLinks.title')}
              </h3>
              <div className="grid md:grid-cols-3 gap-6">
                <QuickLink
                  title={t('quickLinks.explorer.title')}
                  description={t('quickLinks.explorer.description')}
                  href="http://localhost:3000"
                  external
                />
                <QuickLink
                  title={t('quickLinks.startNode.title')}
                  description={t('quickLinks.startNode.description')}
                  href="/docs"
                />
                <QuickLink
                  title={t('quickLinks.technology.title')}
                  description={t('quickLinks.technology.description')}
                  href="/technology"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Loading State */}
        {isLoading && (
          <div className="fixed inset-0 bg-bg-primary/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 border-4 border-accent-cyan/20 border-t-accent-cyan rounded-full animate-spin mx-auto mb-4" />
              <p className="font-display text-text-secondary">加载网络数据...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="group">
      <dt className="text-xs font-display font-semibold text-text-muted uppercase tracking-wider mb-2">
        {label}
      </dt>
      <dd className={`text-text-primary group-hover:text-accent-cyan transition-colors ${
        mono ? 'font-display text-sm' : 'font-body'
      }`}>
        {value}
      </dd>
    </div>
  )
}

function MetricCard({
  title,
  value,
  trend,
}: {
  title: string
  value: string
  trend: 'good' | 'neutral' | 'bad'
}) {
  const trendColors = {
    good: 'text-green-400',
    neutral: 'text-accent-cyan',
    bad: 'text-red-400',
  }

  const trendGlow = {
    good: 'shadow-[0_0_20px_rgba(34,197,94,0.3)]',
    neutral: 'shadow-glow-sm',
    bad: 'shadow-[0_0_20px_rgba(239,68,68,0.3)]',
  }

  return (
    <div className={`group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 ${trendGlow[trend]} hover:${trendGlow[trend].replace('sm', 'md')} noise-texture`}>
      {/* Background Gradient on Hover */}
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      <div className="relative z-10">
        <h3 className="text-xs font-display font-semibold text-text-muted uppercase tracking-wider mb-3">
          {title}
        </h3>
        <p className={`text-3xl md:text-4xl font-display font-bold ${trendColors[trend]} group-hover:glow-text transition-all duration-500`}>
          {value}
        </p>
      </div>

      {/* Bottom Border Accent */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function StatMetricCard({
  title,
  value,
  unit,
  status,
}: {
  title: string
  value: string
  unit?: string
  status?: 'enabled' | 'disabled'
}) {
  const statusColor = status === 'enabled' ? 'text-green-500' : status === 'disabled' ? 'text-gray-500' : ''
  const statusBg = status === 'enabled' ? 'bg-green-500/10' : status === 'disabled' ? 'bg-gray-500/10' : ''

  return (
    <div className={`group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 shadow-glow-sm hover:shadow-glow-md noise-texture ${statusBg}`}>
      <div className="relative z-10">
        <h3 className="text-xs font-display font-semibold text-text-muted uppercase tracking-wider mb-3">
          {title}
        </h3>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl md:text-3xl font-display font-bold text-accent-cyan group-hover:glow-text transition-all duration-500">
            {value}
          </p>
          {unit && <p className="text-xs font-body text-text-secondary">{unit}</p>}
        </div>
        {status && (
          <div className={`text-xs font-display mt-2 ${statusColor}`}>
            {status === 'enabled' ? '✓ 启用' : '✗ 禁用'}
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function QuickLink({
  title,
  description,
  href,
  external = false,
}: {
  title: string
  description: string
  href: string
  external?: boolean
}) {
  const linkProps = external
    ? { target: '_blank', rel: 'noopener noreferrer' }
    : {}

  const Component = external ? 'a' : Link

  return (
    <Component
      href={href}
      {...linkProps}
      className="group block relative bg-bg-elevated rounded-lg p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md overflow-hidden"
    >
      {/* Background Glow on Hover */}
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 transition-opacity duration-500" />

      <div className="relative z-10">
        <h4 className="font-display font-bold text-text-primary group-hover:text-accent-cyan transition-colors mb-2 flex items-center gap-2">
          {title}
          {external && (
            <svg className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          )}
        </h4>
        <p className="text-sm text-text-secondary font-body leading-relaxed">{description}</p>
      </div>

      {/* Bottom Border Accent */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </Component>
  )
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}天 ${hours % 24}小时`
  if (hours > 0) return `${hours}小时 ${minutes % 60}分钟`
  if (minutes > 0) return `${minutes}分钟`
  return `${seconds}秒`
}
