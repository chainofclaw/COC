import Link from 'next/link'
import { provider, formatHash, formatTimestamp, WS_URL } from '@/lib/provider'
import { LiveBlocks } from '@/components/LiveBlocks'
import { LiveTransactions } from '@/components/LiveTransactions'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const latestBlockNumber = await provider.getBlockNumber()

  // Fetch latest 20 blocks
  const blockPromises = Array.from({ length: Math.min(20, latestBlockNumber + 1) }, (_, i) =>
    provider.getBlock(latestBlockNumber - i)
  )
  const blocks = await Promise.all(blockPromises)

  return (
    <div className="space-y-6">
      {/* Real-time section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LiveBlocks />
        <LiveTransactions />
      </div>

      {/* Historical blocks */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-bold mb-4">Latest Blocks</h2>
        <div className="text-sm text-gray-600 mb-4">
          Block Height: <span className="font-mono font-bold text-blue-600">{latestBlockNumber}</span>
        </div>

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
          <p><span className="font-medium">HTTP RPC:</span> <code className="bg-blue-100 px-2 py-1 rounded">http://127.0.0.1:28780</code></p>
          <p><span className="font-medium">WebSocket:</span> <code className="bg-blue-100 px-2 py-1 rounded">{WS_URL}</code></p>
          <p><span className="font-medium">Chain ID:</span> <code className="bg-blue-100 px-2 py-1 rounded">18780 (0x495c)</code></p>
          <p><span className="font-medium">Network:</span> ChainOfClaw (COC)</p>
        </div>
      </div>
    </div>
  )
}
