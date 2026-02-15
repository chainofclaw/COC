import { rpcCall } from '@/lib/rpc'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

interface BlockData {
  number: string
  hash: string
  timestamp: string
  transactions: unknown[]
  gasUsed: string
  gasLimit: string
  miner: string
  baseFeePerGas: string
}

interface PrunerStats {
  latestBlock: number
  pruningHeight: number
  retainedBlocks: number
}

export default async function StatsPage() {
  interface ChainStats {
    blockHeight: string
    latestBlockTime: number
    blocksPerMinute: number
    pendingTxCount: number
    recentTxCount: number
    validatorCount: number
    chainId: string
  }

  const [
    blockHeight,
    gasPrice,
    txPoolStatus,
    prunerStats,
    chainStats,
  ] = await Promise.all([
    rpcCall<string>('eth_blockNumber').catch(() => '0x0'),
    rpcCall<string>('eth_gasPrice').catch(() => '0x0'),
    rpcCall<{ pending: string; queued: string }>('txpool_status').catch(() => ({ pending: '0x0', queued: '0x0' })),
    rpcCall<PrunerStats>('coc_prunerStats').catch(() => null),
    rpcCall<ChainStats>('coc_chainStats').catch(() => null),
  ])

  const height = parseInt(blockHeight, 16)
  const gasPriceGwei = parseInt(gasPrice, 16) / 1e9
  const pendingTxs = parseInt(txPoolStatus.pending, 16)

  // Fetch recent blocks for chain activity stats
  const recentBlockCount = Math.min(20, height)
  const blockPromises: Promise<BlockData | null>[] = []
  for (let i = 0; i < recentBlockCount; i++) {
    const num = `0x${(height - i).toString(16)}`
    blockPromises.push(
      rpcCall<BlockData>('eth_getBlockByNumber', [num, false]).catch(() => null)
    )
  }
  const blocks = (await Promise.all(blockPromises)).filter((b): b is BlockData => b !== null)

  // Calculate stats from recent blocks
  const totalTxs = blocks.reduce((sum, b) => sum + (b.transactions?.length ?? 0), 0)
  const avgTxPerBlock = blocks.length > 0 ? (totalTxs / blocks.length).toFixed(1) : '0'

  const totalGasUsed = blocks.reduce((sum, b) => sum + parseInt(b.gasUsed, 16), 0)
  const avgGasPerBlock = blocks.length > 0 ? Math.round(totalGasUsed / blocks.length) : 0

  // Block time calculation
  let avgBlockTimeMs = 0
  if (blocks.length >= 2) {
    const newest = parseInt(blocks[0].timestamp, 16)
    const oldest = parseInt(blocks[blocks.length - 1].timestamp, 16)
    avgBlockTimeMs = ((newest - oldest) / (blocks.length - 1)) * 1000
  }

  // TPS estimate
  const tps = avgBlockTimeMs > 0
    ? ((parseFloat(avgTxPerBlock) / (avgBlockTimeMs / 1000))).toFixed(2)
    : '0'

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Chain Statistics</h2>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Block Height" value={height.toLocaleString()} />
        <StatCard label="Gas Price" value={`${gasPriceGwei.toFixed(0)} Gwei`} />
        <StatCard label="Pending Txs" value={pendingTxs.toString()} color={pendingTxs > 100 ? 'yellow' : 'default'} />
        <StatCard label="TPS (est.)" value={tps} />
        {chainStats && (
          <>
            <StatCard label="Blocks/min" value={chainStats.blocksPerMinute.toFixed(1)} />
            <StatCard label="Validators" value={String(chainStats.validatorCount)} />
            <StatCard label="Recent Txs (100 blk)" value={chainStats.recentTxCount.toLocaleString()} />
            <StatCard label="Chain ID" value={String(parseInt(chainStats.chainId, 16))} />
          </>
        )}
      </div>

      {/* Block stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-xl font-bold mb-4">Block Activity (Last {blocks.length} Blocks)</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <dt className="text-sm font-medium text-gray-500">Avg Txs / Block</dt>
            <dd className="mt-1 text-2xl font-bold">{avgTxPerBlock}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Avg Gas / Block</dt>
            <dd className="mt-1 text-2xl font-bold">{avgGasPerBlock.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Avg Block Time</dt>
            <dd className="mt-1 text-2xl font-bold">
              {avgBlockTimeMs > 0 ? `${(avgBlockTimeMs / 1000).toFixed(1)}s` : 'N/A'}
            </dd>
          </div>
        </div>
      </div>

      {/* Recent blocks table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <h3 className="text-xl font-bold p-6 pb-2">Recent Blocks</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Block</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Txs</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Gas Used</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Gas %</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {blocks.map((b) => {
                const num = parseInt(b.number, 16)
                const gasUsed = parseInt(b.gasUsed, 16)
                const gasLimit = parseInt(b.gasLimit, 16)
                const gasPercent = gasLimit > 0 ? ((gasUsed / gasLimit) * 100).toFixed(1) : '0'
                const ts = new Date(parseInt(b.timestamp, 16) * 1000)
                return (
                  <tr key={b.hash} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-sm">
                      <Link href={`/block/${num}`} className="text-blue-600 hover:text-blue-800 font-mono">
                        #{num.toLocaleString()}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-sm font-mono">{b.transactions?.length ?? 0}</td>
                    <td className="px-4 py-2 text-sm font-mono">{gasUsed.toLocaleString()}</td>
                    <td className="px-4 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-gray-200 rounded-full h-2">
                          <div
                            className="bg-blue-600 h-2 rounded-full"
                            style={{ width: `${Math.min(100, parseFloat(gasPercent))}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{gasPercent}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {ts.toLocaleTimeString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Storage stats */}
      {prunerStats && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Storage</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <dt className="text-sm font-medium text-gray-500">Retained Blocks</dt>
              <dd className="mt-1 text-2xl font-bold">{prunerStats.retainedBlocks.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Pruning Height</dt>
              <dd className="mt-1 text-2xl font-bold font-mono">#{prunerStats.pruningHeight.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Latest Block</dt>
              <dd className="mt-1 text-2xl font-bold font-mono">#{prunerStats.latestBlock.toLocaleString()}</dd>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color?: 'yellow' | 'default' }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-xs font-medium text-gray-500 uppercase">{label}</div>
      <div className={`mt-1 text-xl font-bold ${color === 'yellow' ? 'text-yellow-600' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  )
}
