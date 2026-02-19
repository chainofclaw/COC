import Link from 'next/link'
import { provider, formatAddress, formatEther } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { decodeMethodSelector, decodeTransferLog, formatTokenAmount } from '@/lib/decoder'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

interface TxPageProps {
  params: Promise<{ hash: string }>
}

interface CallTrace {
  type: string
  from: string
  to: string
  value: string
  gas: string
  gasUsed: string
  input: string
  output: string
  error?: string
}

export default async function TxPage({ params }: TxPageProps) {
  const { hash } = await params

  const [tx, receipt, traces] = await Promise.all([
    provider.getTransaction(hash),
    provider.getTransactionReceipt(hash),
    rpcCall<CallTrace[]>('trace_transaction', [hash]).catch(() => [] as CallTrace[]),
  ])

  if (!tx) {
    notFound()
  }

  const decoded = decodeMethodSelector(tx.data)
  const tokenTransfers = receipt
    ? receipt.logs
        .map((log) => decodeTransferLog({
          address: log.address,
          topics: log.topics as string[],
          data: log.data,
        }))
        .filter((t): t is NonNullable<typeof t> => t !== null)
    : []

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4 gap-2">
          <h2 className="text-xl sm:text-2xl font-bold">Transaction Details</h2>
          {receipt && (
            <span className={`px-3 py-1 rounded text-sm font-medium ${
              receipt.status === 1 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
            }`}>
              {receipt.status === 1 ? 'Success' : 'Failed'}
            </span>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <dt className="text-sm font-medium text-gray-500">Transaction Hash</dt>
            <dd className="mt-1 text-sm font-mono break-all">{tx.hash}</dd>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Block</dt>
              <dd className="mt-1 text-sm">
                {tx.blockNumber ? (
                  <Link href={`/block/${tx.blockNumber}`} className="text-blue-600 hover:text-blue-800">
                    #{tx.blockNumber}
                  </Link>
                ) : 'Pending'}
              </dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-gray-500">Nonce</dt>
              <dd className="mt-1 text-sm font-mono">{tx.nonce}</dd>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">From</dt>
              <dd className="mt-1 text-sm">
                <Link href={`/address/${tx.from}`} className="text-blue-600 hover:text-blue-800 font-mono">
                  {formatAddress(tx.from)}
                </Link>
              </dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-gray-500">To</dt>
              <dd className="mt-1 text-sm">
                {tx.to ? (
                  <Link href={`/address/${tx.to}`} className="text-blue-600 hover:text-blue-800 font-mono">
                    {formatAddress(tx.to)}
                  </Link>
                ) : <span className="text-gray-500">[Contract Creation]</span>}
              </dd>
            </div>
          </div>

          <div>
            <dt className="text-sm font-medium text-gray-500">Value</dt>
            <dd className="mt-1 text-sm font-mono">{formatEther(tx.value)}</dd>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Gas Limit</dt>
              <dd className="mt-1 text-sm font-mono">{tx.gasLimit?.toString()}</dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-gray-500">Gas Price</dt>
              <dd className="mt-1 text-sm font-mono">{tx.gasPrice?.toString()}</dd>
            </div>

            {receipt && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Gas Used</dt>
                <dd className="mt-1 text-sm font-mono">{receipt.gasUsed?.toString()}</dd>
              </div>
            )}
          </div>

          {/* Decoded method */}
          {decoded && (
            <div>
              <dt className="text-sm font-medium text-gray-500">Method</dt>
              <dd className="mt-1">
                <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded text-sm font-mono">
                  {decoded.name}
                </span>
              </dd>
            </div>
          )}

          {tx.data && tx.data !== '0x' && (
            <div>
              <dt className="text-sm font-medium text-gray-500">Input Data</dt>
              <dd className="mt-1 text-xs font-mono bg-gray-50 p-3 rounded break-all">{tx.data}</dd>
            </div>
          )}
        </div>
      </div>

      {/* Token transfers */}
      {tokenTransfers.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Token Transfers ({tokenTransfers.length})</h3>
          <div className="space-y-3">
            {tokenTransfers.map((t, i) => (
              <div key={i} className="flex items-center gap-2 sm:gap-3 bg-yellow-50 border border-yellow-200 p-2 sm:p-3 rounded text-sm flex-wrap">
                <span className="px-2 py-0.5 bg-yellow-200 text-yellow-800 rounded text-xs font-medium">
                  {t.type === 'ERC20-Transfer' ? 'Transfer' : 'Approval'}
                </span>
                <span className="font-mono font-medium text-xs sm:text-sm">{formatTokenAmount(t.value)}</span>
                <span className="text-gray-500 text-xs">from</span>
                <Link href={`/address/${t.from}`} className="text-blue-600 font-mono text-xs">
                  {formatAddress(t.from)}
                </Link>
                <span className="text-gray-500 text-xs">to</span>
                <Link href={`/address/${t.to}`} className="text-blue-600 font-mono text-xs">
                  {formatAddress(t.to)}
                </Link>
                <span className="text-gray-400 text-xs hidden sm:inline">
                  via <Link href={`/address/${t.contractAddress}`} className="text-blue-600">{formatAddress(t.contractAddress)}</Link>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Internal Transactions (call trace) */}
      {traces.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Internal Transactions ({traces.length})</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">From</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">To</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase hidden md:table-cell">Gas Used</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {traces.map((trace, i) => {
                  const traceValue = BigInt(trace.value || '0x0')
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-sm">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          trace.type === 'CREATE' ? 'bg-indigo-100 text-indigo-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {trace.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <Link href={`/address/${trace.from}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                          {formatAddress(trace.from)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm hidden sm:table-cell">
                        <Link href={`/address/${trace.to}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                          {formatAddress(trace.to)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm font-mono text-xs">
                        {traceValue > 0n ? formatEther(traceValue) : '0'}
                      </td>
                      <td className="px-3 py-2 text-sm font-mono text-xs hidden md:table-cell">
                        {parseInt(trace.gasUsed, 16).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-sm">
                        {trace.error ? (
                          <span className="text-red-600 text-xs">{trace.error}</span>
                        ) : (
                          <span className="text-green-600 text-xs">OK</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Event logs */}
      {receipt && receipt.logs.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Event Logs ({receipt.logs.length})</h3>
          <div className="space-y-3">
            {receipt.logs.map((log, i) => (
              <div key={i} className="bg-gray-50 p-4 rounded">
                <div className="text-sm space-y-2">
                  <div>
                    <span className="font-medium">Address:</span>{' '}
                    <Link href={`/address/${log.address}`} className="text-blue-600 font-mono text-xs">
                      {log.address}
                    </Link>
                  </div>
                  <div>
                    <span className="font-medium">Topics:</span>
                    <div className="mt-1 space-y-1">
                      {log.topics.map((topic, j) => (
                        <div key={j} className="text-xs font-mono bg-white p-2 rounded">{topic}</div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="font-medium">Data:</span>
                    <div className="text-xs font-mono bg-white p-2 rounded mt-1 break-all">{log.data}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
