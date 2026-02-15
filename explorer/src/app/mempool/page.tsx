import Link from 'next/link'
import { formatAddress, formatEther } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { decodeMethodSelector } from '@/lib/decoder'
import { LiveTransactions } from '@/components/LiveTransactions'

export const dynamic = 'force-dynamic'

interface TxPoolStatus {
  pending: string
  queued: string
}

interface TxPoolEntry {
  hash: string
  nonce: string
  from: string
  to: string | null
  value: string
  gas: string
  gasPrice: string
  input: string
}

interface TxPoolContent {
  pending: Record<string, Record<string, TxPoolEntry>>
  queued: Record<string, Record<string, TxPoolEntry>>
}

export default async function MempoolPage() {
  const [status, content] = await Promise.all([
    rpcCall<TxPoolStatus>('txpool_status').catch(() => ({ pending: '0x0', queued: '0x0' })),
    rpcCall<TxPoolContent>('txpool_content').catch(() => ({ pending: {}, queued: {} })),
  ])

  const pendingCount = parseInt(status.pending, 16)
  const queuedCount = parseInt(status.queued, 16)

  // Flatten pending txs for display
  const pendingTxs: TxPoolEntry[] = []
  for (const senderTxs of Object.values(content.pending)) {
    for (const tx of Object.values(senderTxs)) {
      pendingTxs.push(tx)
    }
  }

  // Sort by gas price descending
  pendingTxs.sort((a, b) => {
    const aPrice = BigInt(a.gasPrice || '0x0')
    const bPrice = BigInt(b.gasPrice || '0x0')
    return aPrice > bPrice ? -1 : aPrice < bPrice ? 1 : 0
  })

  return (
    <div className="space-y-6">
      {/* Pool stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Pending</div>
          <div className="mt-1 text-2xl font-bold text-yellow-600">{pendingCount}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Queued</div>
          <div className="mt-1 text-2xl font-bold text-gray-600">{queuedCount}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Unique Senders</div>
          <div className="mt-1 text-2xl font-bold">{Object.keys(content.pending).length}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Pool Capacity</div>
          <div className="mt-1 text-2xl font-bold">{pendingCount} / 4096</div>
        </div>
      </div>

      {/* Live pending tx stream */}
      <LiveTransactions />

      {/* Pending transactions table */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-bold mb-4">Pending Transactions ({pendingTxs.length})</h2>

        {pendingTxs.length === 0 ? (
          <p className="text-gray-500 text-sm">No pending transactions in the mempool.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Hash</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">From</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">To</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Nonce</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Gas Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {pendingTxs.map((tx) => {
                  const decoded = decodeMethodSelector(tx.input)
                  return (
                    <tr key={tx.hash} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={`/tx/${tx.hash}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                          {tx.hash.slice(0, 10)}...{tx.hash.slice(-6)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {decoded ? (
                          <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-mono">
                            {decoded.name.split('(')[0]}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">
                            {tx.input && tx.input !== '0x' ? tx.input.slice(0, 10) : 'transfer'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={`/address/${tx.from}`} className="text-blue-600 font-mono text-xs">
                          {formatAddress(tx.from)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {tx.to ? (
                          <Link href={`/address/${tx.to}`} className="text-blue-600 font-mono text-xs">
                            {formatAddress(tx.to)}
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-500">[Contract]</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                        {formatEther(BigInt(tx.value || '0x0'))}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                        {parseInt(tx.nonce, 16)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                        {(parseInt(tx.gasPrice, 16) / 1e9).toFixed(1)} Gwei
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
