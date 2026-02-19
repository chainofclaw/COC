import Link from 'next/link'
import { provider, formatHash, formatTimestamp, formatEther, formatAddress } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { decodeMethodSelector, decodeTransferLog, formatTokenAmount } from '@/lib/decoder'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

interface BlockPageProps {
  params: Promise<{ id: string }>
}

interface BlockReceipt {
  transactionHash: string
  transactionIndex: string
  blockNumber: string
  blockHash: string
  from: string
  to: string | null
  gasUsed: string
  status: string
  logs: Array<{ address: string; topics: string[]; data: string }>
}

export default async function BlockPage({ params }: BlockPageProps) {
  const { id } = await params
  const blockNumber = parseInt(id, 10)

  if (isNaN(blockNumber)) {
    notFound()
  }

  const block = await provider.getBlock(blockNumber)
  if (!block) {
    notFound()
  }

  // Fetch raw block data for extra fields (stateRoot, miner, baseFeePerGas)
  const rawBlock = await rpcCall<{
    stateRoot?: string
    miner?: string
    baseFeePerGas?: string
    extraData?: string
  }>('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]).catch(() => null)

  // Fetch full transaction details for each tx in the block
  const [txDetails, receipts] = await Promise.all([
    Promise.all(
      block.transactions.map((hash) => provider.getTransaction(hash))
    ),
    rpcCall<BlockReceipt[]>('eth_getBlockReceipts', [`0x${blockNumber.toString(16)}`]).catch(() => []),
  ])

  // Build receipt lookup by tx hash
  const receiptMap = new Map<string, BlockReceipt>()
  for (const r of receipts) {
    if (r?.transactionHash) receiptMap.set(r.transactionHash.toLowerCase(), r)
  }

  // Navigation helpers
  const prevBlock = blockNumber > 0 ? blockNumber - 1 : null
  const latestBlock = await provider.getBlockNumber()
  const nextBlock = blockNumber < latestBlock ? blockNumber + 1 : null

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl sm:text-2xl font-bold">Block #{block.number}</h2>
          <div className="flex gap-2">
            {prevBlock !== null && (
              <Link href={`/block/${prevBlock}`} className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm">
                &larr; Prev
              </Link>
            )}
            {nextBlock !== null && (
              <Link href={`/block/${nextBlock}`} className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm">
                Next &rarr;
              </Link>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <dt className="text-sm font-medium text-gray-500">Block Hash</dt>
            <dd className="mt-1 text-sm font-mono break-all">{block.hash}</dd>
          </div>

          <div>
            <dt className="text-sm font-medium text-gray-500">Parent Hash</dt>
            <dd className="mt-1 text-sm font-mono break-all">
              {blockNumber > 0 ? (
                <Link href={`/block/${blockNumber - 1}`} className="text-blue-600 hover:text-blue-800">
                  {block.parentHash}
                </Link>
              ) : block.parentHash}
            </dd>
          </div>

          <div>
            <dt className="text-sm font-medium text-gray-500">Timestamp</dt>
            <dd className="mt-1 text-sm">{formatTimestamp(block.timestamp)}</dd>
          </div>

          <div>
            <dt className="text-sm font-medium text-gray-500">Gas Used / Limit</dt>
            <dd className="mt-1 text-sm font-mono">
              {block.gasUsed?.toString()} / {block.gasLimit?.toString()}
              {block.gasLimit && block.gasUsed ? (
                <span className="ml-2 text-xs text-gray-400">
                  ({((Number(block.gasUsed) / Number(block.gasLimit)) * 100).toFixed(1)}%)
                </span>
              ) : null}
            </dd>
          </div>

          <div>
            <dt className="text-sm font-medium text-gray-500">Transactions</dt>
            <dd className="mt-1 text-sm">{block.transactions.length}</dd>
          </div>

          {rawBlock?.miner && rawBlock.miner !== '0x0000000000000000000000000000000000000000' && (
            <div>
              <dt className="text-sm font-medium text-gray-500">Proposer</dt>
              <dd className="mt-1 text-sm">
                <Link href={`/address/${rawBlock.miner}`} className="text-blue-600 hover:text-blue-800 font-mono">
                  {formatAddress(rawBlock.miner)}
                </Link>
              </dd>
            </div>
          )}

          {rawBlock?.stateRoot && rawBlock.stateRoot !== '0x' + '0'.repeat(64) && (
            <div>
              <dt className="text-sm font-medium text-gray-500">State Root</dt>
              <dd className="mt-1 text-sm font-mono break-all text-xs">{rawBlock.stateRoot}</dd>
            </div>
          )}

          {rawBlock?.baseFeePerGas && (
            <div>
              <dt className="text-sm font-medium text-gray-500">Base Fee</dt>
              <dd className="mt-1 text-sm font-mono">{(parseInt(rawBlock.baseFeePerGas, 16) / 1e9).toFixed(2)} Gwei</dd>
            </div>
          )}
        </div>
      </div>

      {/* Transaction table */}
      {block.transactions.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">
            Transactions ({block.transactions.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Hash</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">Method</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">From</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase hidden md:table-cell">To</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase hidden lg:table-cell">Gas Used</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {block.transactions.map((txHash, idx) => {
                  const tx = txDetails[idx]
                  const receipt = receiptMap.get(txHash.toLowerCase())
                  const decoded = tx ? decodeMethodSelector(tx.data) : null

                  return (
                    <tr key={txHash} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={`/tx/${txHash}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                          {formatHash(txHash)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap hidden sm:table-cell">
                        {decoded ? (
                          <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-mono">
                            {decoded.name.split('(')[0]}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">
                            {tx?.data && tx.data !== '0x' ? tx.data.slice(0, 10) : 'transfer'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {tx ? (
                          <Link href={`/address/${tx.from}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                            {formatAddress(tx.from)}
                          </Link>
                        ) : '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap hidden md:table-cell">
                        {tx?.to ? (
                          <Link href={`/address/${tx.to}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                            {formatAddress(tx.to)}
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-500">[Contract]</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                        {tx ? formatEther(tx.value) : '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {receipt ? (
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                            receipt.status === '0x1' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {receipt.status === '0x1' ? 'OK' : 'Fail'}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs hidden lg:table-cell">
                        {receipt ? parseInt(receipt.gasUsed, 16).toLocaleString() : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Token transfers in this block */}
      <BlockTokenTransfers receipts={receipts} />
    </div>
  )
}

function BlockTokenTransfers({ receipts }: { receipts: BlockReceipt[] }) {
  const transfers: Array<{ txHash: string; transfer: NonNullable<ReturnType<typeof decodeTransferLog>> }> = []

  for (const r of receipts) {
    for (const log of r.logs ?? []) {
      const t = decodeTransferLog(log)
      if (t) transfers.push({ txHash: r.transactionHash, transfer: t })
    }
  }

  if (transfers.length === 0) return null

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-xl font-bold mb-4">Token Transfers ({transfers.length})</h3>
      <div className="space-y-2">
        {transfers.map((item, i) => (
          <div key={i} className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 p-3 rounded text-sm flex-wrap">
            <span className="px-1.5 py-0.5 bg-yellow-200 text-yellow-800 rounded text-xs font-medium">
              {item.transfer.type === 'ERC20-Transfer' ? 'Transfer' : 'Approval'}
            </span>
            <span className="font-mono font-medium text-xs">{formatTokenAmount(item.transfer.value)}</span>
            <span className="text-gray-500 text-xs">from</span>
            <Link href={`/address/${item.transfer.from}`} className="text-blue-600 font-mono text-xs">
              {formatAddress(item.transfer.from)}
            </Link>
            <span className="text-gray-500 text-xs">to</span>
            <Link href={`/address/${item.transfer.to}`} className="text-blue-600 font-mono text-xs">
              {formatAddress(item.transfer.to)}
            </Link>
            <Link href={`/tx/${item.txHash}`} className="text-gray-400 text-xs hover:text-blue-600 ml-auto font-mono">
              {formatHash(item.txHash)}
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}
