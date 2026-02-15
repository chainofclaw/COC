import Link from 'next/link'
import { provider, formatHash, formatTimestamp, WS_URL, RPC_URL } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { LiveBlocks } from '@/components/LiveBlocks'
import { LiveTransactions } from '@/components/LiveTransactions'

export const dynamic = 'force-dynamic'

async function getChainStats() {
  const [blockNumber, gasPrice, chainId, syncing, peerCount] = await Promise.all([
    provider.getBlockNumber(),
    rpcCall<string>('eth_gasPrice').catch(() => '0x0'),
    rpcCall<string>('eth_chainId').catch(() => '0x495c'),
    rpcCall<boolean>('eth_syncing').catch(() => false),
    rpcCall<string>('net_peerCount').catch(() => '0x0'),
  ])

  // Calculate avg block time from last 10 blocks
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

  // Count total txs in last 10 blocks
  let recentTxCount = 0
  const recentBlockCount = Math.min(10, blockNumber + 1)
  const recentBlocks = await Promise.all(
    Array.from({ length: recentBlockCount }, (_, i) => provider.getBlock(blockNumber - i))
  )
  for (const b of recentBlocks) {
    if (b) recentTxCount += b.transactions.length
  }

  return {
    blockNumber,
    gasPrice: parseInt(gasPrice, 16),
    chainId: parseInt(chainId, 16),
    syncing,
    peerCount: parseInt(peerCount, 16),
    avgBlockTimeMs,
    recentTxCount,
    recentBlockCount,
  }
}

export default async function HomePage() {
  const stats = await getChainStats()

  // Fetch latest 20 blocks
  const blockPromises = Array.from({ length: Math.min(20, stats.blockNumber + 1) }, (_, i) =>
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
          label="Recent Txs"
          value={`${stats.recentTxCount}`}
          sub={`last ${stats.recentBlockCount} blocks`}
        />
        <StatCard label="Peers" value={stats.peerCount.toString()} />
        <StatCard label="Gas Price" value={`${(stats.gasPrice / 1e9).toFixed(0)} Gwei`} />
        <StatCard label="Chain ID" value={`${stats.chainId} (0x${stats.chainId.toString(16)})`} />
        <StatCard label="Syncing" value={stats.syncing ? 'Yes' : 'No'} />
        <StatCard label="Network" value="ChainOfClaw" />
      </div>

      {/* Real-time section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LiveBlocks />
        <LiveTransactions />
      </div>

      {/* Historical blocks */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-bold mb-4">Latest Blocks</h2>

        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Block</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hash</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Timestamp</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Txs</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Gas Used</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {blocks.map((block) => {
                if (!block) return null
                return (
                  <tr key={block.number} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Link
                        href={`/block/${block.number}`}
                        className="text-blue-600 hover:text-blue-800 font-mono"
                      >
                        {block.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-sm">
                      {block.hash ? formatHash(block.hash) : 'N/A'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                      {formatTimestamp(block.timestamp)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      {block.transactions.length}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-sm">
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
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">Connection Info</h3>
        <div className="text-sm space-y-1">
          <p><span className="font-medium">HTTP RPC:</span> <code className="bg-blue-100 px-2 py-1 rounded">{RPC_URL}</code></p>
          <p><span className="font-medium">WebSocket:</span> <code className="bg-blue-100 px-2 py-1 rounded">{WS_URL}</code></p>
          <p><span className="font-medium">Chain ID:</span> <code className="bg-blue-100 px-2 py-1 rounded">{stats.chainId} (0x{stats.chainId.toString(16)})</code></p>
          <p><span className="font-medium">Network:</span> ChainOfClaw (COC)</p>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-xs font-medium text-gray-500 uppercase">{label}</div>
      <div className="mt-1 text-lg font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  )
}
