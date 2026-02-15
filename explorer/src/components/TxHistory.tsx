'use client'

import { useState } from 'react'
import Link from 'next/link'
import { formatAddress } from '@/lib/provider'
import { decodeMethodSelector, decodeTransferLog, formatTokenAmount } from '@/lib/decoder'
import type { AddressTx } from '@/lib/rpc'

interface TxHistoryProps {
  address: string
  initialTxs: AddressTx[]
}

type TxFilter = 'all' | 'sent' | 'received' | 'contract' | 'token'

export function TxHistory({ address, initialTxs }: TxHistoryProps) {
  const [filter, setFilter] = useState<TxFilter>('all')
  const addrLower = address.toLowerCase()

  const txsWithTokens = initialTxs.map((tx) => {
    const transfers = (tx.logs ?? [])
      .map((log) => decodeTransferLog(log))
      .filter((t): t is NonNullable<typeof t> => t !== null)
    return { ...tx, tokenTransfers: transfers }
  })

  const filtered = txsWithTokens.filter((tx) => {
    if (filter === 'sent') return tx.from?.toLowerCase() === addrLower
    if (filter === 'received') return tx.to?.toLowerCase() === addrLower
    if (filter === 'contract') return tx.input && tx.input.length > 10
    if (filter === 'token') return tx.tokenTransfers.length > 0
    return true
  })

  const tokenTxCount = txsWithTokens.filter((tx) => tx.tokenTransfers.length > 0).length

  const filters: { key: TxFilter; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'sent', label: 'Sent' },
    { key: 'received', label: 'Received' },
    { key: 'contract', label: 'Contract' },
    { key: 'token', label: 'Token', count: tokenTxCount },
  ]

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold">Transactions ({initialTxs.length})</h3>
        <div className="flex gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1 text-sm rounded ${
                filter === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {f.label}{f.count ? ` (${f.count})` : ''}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm py-4">No transactions found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Hash</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Block</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Dir</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">From / To</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Gas</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map((tx) => {
                const isSent = tx.from?.toLowerCase() === addrLower
                const counterparty = isSent ? tx.to : tx.from
                const decoded = decodeMethodSelector(tx.input)
                const blockNum = parseInt(tx.blockNumber, 16)
                const success = tx.status === '0x1'
                const gasUsed = parseInt(tx.gasUsed, 16)

                return (
                  <tr key={tx.hash} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-sm">
                      <Link href={`/tx/${tx.hash}`} className="text-blue-600 hover:text-blue-800 font-mono">
                        {tx.hash.slice(0, 10)}...
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <Link href={`/block/${blockNum}`} className="text-blue-600 hover:text-blue-800">
                        #{blockNum}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        isSent ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {isSent ? 'OUT' : 'IN'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm font-mono">
                      {counterparty ? (
                        <Link href={`/address/${counterparty}`} className="text-blue-600 hover:text-blue-800">
                          {formatAddress(counterparty)}
                        </Link>
                      ) : (
                        <span className="text-gray-400">[Contract Create]</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      {decoded ? (
                        <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs" title={decoded.name}>
                          {decoded.name.split('(')[0]}
                        </span>
                      ) : (
                        <span className="text-gray-500 text-xs">Transfer</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono text-xs text-gray-600">
                      {gasUsed > 0 ? gasUsed.toLocaleString() : '-'}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <span className={success ? 'text-green-600' : 'text-red-600'}>
                        {success ? 'OK' : 'Fail'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Token transfers summary */}
      {filter === 'token' && filtered.length > 0 && (
        <div className="mt-4 space-y-2">
          {filtered.map((tx) =>
            tx.tokenTransfers.map((t, i) => (
              <div key={`${tx.hash}-${i}`} className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 p-2 rounded text-xs flex-wrap">
                <Link href={`/tx/${tx.hash}`} className="text-blue-600 font-mono">
                  {tx.hash.slice(0, 10)}...
                </Link>
                <span className="px-1.5 py-0.5 bg-yellow-200 text-yellow-800 rounded font-medium">
                  {t.type === 'ERC20-Transfer' ? 'Transfer' : 'Approval'}
                </span>
                <span className="font-mono font-medium">{formatTokenAmount(t.value)}</span>
                <span className="text-gray-400">from</span>
                <Link href={`/address/${t.from}`} className="text-blue-600 font-mono">{formatAddress(t.from)}</Link>
                <span className="text-gray-400">to</span>
                <Link href={`/address/${t.to}`} className="text-blue-600 font-mono">{formatAddress(t.to)}</Link>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
