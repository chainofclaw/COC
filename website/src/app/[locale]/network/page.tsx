import { NetworkStats } from '@/components/NetworkStats'
import { provider } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

async function getNetworkInfo() {
  try {
    const nodeInfo = await rpcCall<{
      runtime: string
      version: string
      startTime: number
      uptime: number
      endpoints: {
        rpc: string
        ws: string
        p2p: string
      }
    }>('coc_nodeInfo').catch(() => null)

    const validators = await rpcCall<Array<{
      address: string
      score: number
      blocks: number
    }>>('coc_validators').catch(() => [])

    return { nodeInfo, validators }
  } catch (error) {
    console.error('Failed to fetch network info:', error)
    return { nodeInfo: null, validators: [] }
  }
}

async function getRecentBlocks() {
  try {
    const blockNumber = await provider.getBlockNumber()
    const count = Math.min(10, blockNumber + 1)
    const blocks = await Promise.all(
      Array.from({ length: count }, (_, i) => provider.getBlock(blockNumber - i))
    )
    return blocks.filter(Boolean)
  } catch (error) {
    console.error('Failed to fetch recent blocks:', error)
    return []
  }
}

export default async function NetworkPage() {
  const t = await getTranslations('network')
  const { nodeInfo, validators } = await getNetworkInfo()
  const recentBlocks = await getRecentBlocks()

  // Calculate stats from recent blocks
  let avgBlockTime = 0
  let avgTxCount = 0
  let avgGasUsed = 0n

  if (recentBlocks.length > 1) {
    const timestamps = recentBlocks.map(b => b!.timestamp)
    const timeDiffs = []
    for (let i = 0; i < timestamps.length - 1; i++) {
      timeDiffs.push(timestamps[i] - timestamps[i + 1])
    }
    avgBlockTime = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length

    avgTxCount = recentBlocks.reduce((sum, b) => sum + b!.transactions.length, 0) / recentBlocks.length
    avgGasUsed = recentBlocks.reduce((sum, b) => sum + (b!.gasUsed || 0n), 0n) / BigInt(recentBlocks.length)
  }

  return (
    <div className="bg-gray-50 min-h-screen">
      {/* Header */}
      <section className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white py-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-2">{t('title')}</h1>
          <p className="text-blue-100">{t('subtitle')}</p>
        </div>
      </section>

      <div className="container mx-auto px-4 py-8">
        {/* Real-time Stats */}
        <section className="mb-8">
          <h2 className="text-2xl font-bold mb-4 text-gray-900">{t('realTimeStats')}</h2>
          <NetworkStats />
        </section>

        {/* Node Info */}
        {nodeInfo && (
          <section className="mb-8">
            <h2 className="text-2xl font-bold mb-4 text-gray-900">{t('nodeInfo.title')}</h2>
            <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
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
        <section className="mb-8">
          <h2 className="text-2xl font-bold mb-4 text-gray-900">{t('performanceMetrics.title')}</h2>
          <div className="grid md:grid-cols-3 gap-4">
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

        {/* Validators */}
        {validators.length > 0 && (
          <section className="mb-8">
            <h2 className="text-2xl font-bold mb-4 text-gray-900">{t('validators.title')}</h2>
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <table className="min-w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('validators.address')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('validators.score')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('validators.blocks')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {validators.map((v, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-mono text-sm">{v.address}</td>
                      <td className="px-6 py-4">{v.score}</td>
                      <td className="px-6 py-4">{v.blocks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Recent Blocks */}
        <section className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-gray-900">{t('recentBlocks.title')}</h2>
            <a
              href="http://localhost:3000"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 font-semibold"
            >
              {t('recentBlocks.viewExplorer')}
            </a>
          </div>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('recentBlocks.blockHeight')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('recentBlocks.timestamp')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('recentBlocks.txCount')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('recentBlocks.gasUsed')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {recentBlocks.map((block) => (
                  <tr key={block!.number} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-mono">
                      <a
                        href={`http://localhost:3000/block/${block!.number}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800"
                      >
                        {block!.number}
                      </a>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {new Date(block!.timestamp * 1000).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-6 py-4 text-center">{block!.transactions.length}</td>
                    <td className="px-6 py-4 font-mono text-sm">{block!.gasUsed?.toString() || '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Quick Links */}
        <section>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-blue-900 mb-4">{t('quickLinks.title')}</h3>
            <div className="grid md:grid-cols-3 gap-4">
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
        </section>
      </div>
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-sm font-medium text-gray-500 mb-1">{label}</dt>
      <dd className={`text-gray-900 ${mono ? 'font-mono text-sm' : ''}`}>{value}</dd>
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
    good: 'text-green-600',
    neutral: 'text-gray-900',
    bad: 'text-red-600',
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
      <h3 className="text-sm font-medium text-gray-500 mb-2">{title}</h3>
      <p className={`text-2xl font-bold ${trendColors[trend]}`}>{value}</p>
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
      className="block bg-white p-4 rounded-lg border border-blue-200 hover:border-blue-400 transition"
    >
      <h4 className="font-semibold text-blue-900 mb-1">{title}</h4>
      <p className="text-sm text-gray-600">{description}</p>
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
