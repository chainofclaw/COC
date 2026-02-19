import Link from 'next/link'
import { provider, formatHash, formatTimestamp, WS_URL, RPC_URL } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { LiveBlocks } from '@/components/LiveBlocks'
import { LiveTransactions } from '@/components/LiveTransactions'

export const dynamic = 'force-dynamic'

interface ChainStatsRpc {
  blockHeight: string
  latestBlockTime: number
  blocksPerMinute: number
  pendingTxCount: number
  recentTxCount: number
  validatorCount: number
  chainId: string
}

async function getChainStats() {
  // Use coc_chainStats for efficient server-side aggregation
  const [chainStats, gasPrice, syncing, peerCount] = await Promise.all([
    rpcCall<ChainStatsRpc>('coc_chainStats').catch(() => null),
    rpcCall<string>('eth_gasPrice').catch(() => '0x0'),
    rpcCall<boolean>('eth_syncing').catch(() => false),
    rpcCall<string>('net_peerCount').catch(() => '0x0'),
  ])

  const blockNumber = chainStats
    ? parseInt(chainStats.blockHeight, 16)
    : await provider.getBlockNumber()
  const chainId = chainStats
    ? parseInt(chainStats.chainId, 16)
    : 18780

  // Calculate avg block time from newest and 10th-newest block
  let avgBlockTimeMs = 0
  if (blockNumber > 1) {
    const count = Math.min(10, blockNumber)
    const [newest, oldest] = await Promise.all([
      provider.getBlock(blockNumber),
      provider.getBlock(blockNumber - count + 1),
    ])
    if (newest && oldest && newest.timestamp > oldest.timestamp) {
      avgBlockTimeMs = ((newest.timestamp - oldest.timestamp) * 1000) / (count - 1)
    }
  }

  return {
    blockNumber,
    gasPrice: parseInt(gasPrice, 16),
    chainId,
    syncing,
    peerCount: parseInt(peerCount, 16),
    avgBlockTimeMs,
    recentTxCount: chainStats?.recentTxCount ?? 0,
    blocksPerMinute: chainStats?.blocksPerMinute ?? 0,
    pendingTxCount: chainStats?.pendingTxCount ?? 0,
    validatorCount: chainStats?.validatorCount ?? 0,
  }
}

export default async function HomePage() {
  const stats = await getChainStats()

  // Fetch latest 10 blocks (reduced from 20 for faster load)
  const blockCount = Math.min(10, stats.blockNumber + 1)
  const blockPromises = Array.from({ length: blockCount }, (_, i) =>
    provider.getBlock(stats.blockNumber - i)
  )
  const blocks = await Promise.all(blockPromises)

  return (
    <div className="space-y-6">
      {/* Chain stats dashboard */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Block Height" value={stats.blockNumber.toLocaleString()} />
        <StatCard
          label="Avg Block Time"
          value={stats.avgBlockTimeMs > 0 ? `${(stats.avgBlockTimeMs / 1000).toFixed(1)}s` : 'N/A'}
        />
        <StatCard
          label="Blocks/min"
          value={stats.blocksPerMinute > 0 ? stats.blocksPerMinute.toFixed(1) : 'N/A'}
        />
        <StatCard label="Peers" value={stats.peerCount.toString()} />
        <StatCard label="Gas Price" value={`${(stats.gasPrice / 1e9).toFixed(0)} Gwei`} />
        <StatCard label="Pending Txs" value={stats.pendingTxCount.toString()} />
        <StatCard
          label="Recent Txs"
          value={stats.recentTxCount.toLocaleString()}
          sub="last 100 blocks"
        />
        <StatCard label="Validators" value={stats.validatorCount.toString()} />
      </div>

      {/* Real-time section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LiveBlocks />
        <LiveTransactions />
      </div>

      {/* Historical blocks */}
      <div className="bg-white rounded-lg shadow p-4 sm:p-6">
        <h2 className="text-xl sm:text-2xl font-bold mb-4">Latest Blocks</h2>

        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Block</th>
                <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden md:table-cell">Hash</th>
                <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Txs</th>
                <th className="px-3 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">Gas Used</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {blocks.map((block) => {
                if (!block) return null
                return (
                  <tr key={block.number} className="hover:bg-gray-50">
                    <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                      <Link
                        href={`/block/${block.number}`}
                        className="text-blue-600 hover:text-blue-800 font-mono text-sm"
                      >
                        {block.number}
                      </Link>
                    </td>
                    <td className="px-3 sm:px-4 py-3 whitespace-nowrap font-mono text-sm hidden md:table-cell">
                      {block.hash ? formatHash(block.hash) : 'N/A'}
                    </td>
                    <td className="px-3 sm:px-4 py-3 whitespace-nowrap text-xs sm:text-sm text-gray-600">
                      {formatTimestamp(block.timestamp)}
                    </td>
                    <td className="px-3 sm:px-4 py-3 whitespace-nowrap text-center text-sm">
                      {block.transactions.length}
                    </td>
                    <td className="px-3 sm:px-4 py-3 whitespace-nowrap font-mono text-sm hidden sm:table-cell">
                      {block.gasUsed?.toString() || '0'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Connection info */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
        <h3 className="font-semibold text-blue-900 mb-2 text-sm sm:text-base">Connection Info</h3>
        <div className="text-xs sm:text-sm space-y-1">
          <p><span className="font-medium">HTTP RPC:</span> <code className="bg-blue-100 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded text-[11px] sm:text-sm break-all">{RPC_URL}</code></p>
          <p><span className="font-medium">WebSocket:</span> <code className="bg-blue-100 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded text-[11px] sm:text-sm break-all">{WS_URL}</code></p>
          <p><span className="font-medium">Chain ID:</span> <code className="bg-blue-100 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded text-[11px] sm:text-sm">{stats.chainId} (0x{stats.chainId.toString(16)})</code></p>
          <p><span className="font-medium">Network:</span> ChainOfClaw (COC)</p>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-3 sm:p-4">
      <div className="text-[10px] sm:text-xs font-medium text-gray-500 uppercase truncate">{label}</div>
      <div className="mt-1 text-base sm:text-lg font-bold text-gray-900 truncate">{value}</div>
      {sub && <div className="text-[10px] sm:text-xs text-gray-400">{sub}</div>}
    </div>
  )
}
