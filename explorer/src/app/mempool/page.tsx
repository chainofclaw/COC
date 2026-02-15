'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { formatAddress, formatEther } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { decodeMethodSelector } from '@/lib/decoder'
import { LiveTransactions } from '@/components/LiveTransactions'

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

type SortKey = 'gasPrice' | 'value' | 'nonce'
type SortDir = 'asc' | 'desc'
type PoolTab = 'pending' | 'queued'

export default function MempoolPage() {
  const [status, setStatus] = useState<TxPoolStatus>({ pending: '0x0', queued: '0x0' })
  const [content, setContent] = useState<TxPoolContent>({ pending: {}, queued: {} })
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('gasPrice')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [tab, setTab] = useState<PoolTab>('pending')
  const [filterSender, setFilterSender] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, c] = await Promise.all([
        rpcCall<TxPoolStatus>('txpool_status').catch(() => ({ pending: '0x0', queued: '0x0' })),
        rpcCall<TxPoolContent>('txpool_content').catch(() => ({ pending: {}, queued: {} })),
      ])
      setStatus(s)
      setContent(c)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const pendingCount = parseInt(status.pending, 16)
  const queuedCount = parseInt(status.queued, 16)

  // Flatten txs for current tab
  const poolData = tab === 'pending' ? content.pending : content.queued
  let txs: TxPoolEntry[] = []
  for (const senderTxs of Object.values(poolData)) {
    for (const tx of Object.values(senderTxs)) {
      txs.push(tx)
    }
  }

  // Filter by sender
  if (filterSender) {
    const f = filterSender.toLowerCase()
    txs = txs.filter((tx) => tx.from.toLowerCase().includes(f))
  }

  // Sort
  txs.sort((a, b) => {
    let cmp = 0
    if (sortKey === 'gasPrice') {
      const av = BigInt(a.gasPrice || '0x0')
      const bv = BigInt(b.gasPrice || '0x0')
      cmp = av > bv ? 1 : av < bv ? -1 : 0
    } else if (sortKey === 'value') {
      const av = BigInt(a.value || '0x0')
      const bv = BigInt(b.value || '0x0')
      cmp = av > bv ? 1 : av < bv ? -1 : 0
    } else if (sortKey === 'nonce') {
      cmp = parseInt(a.nonce, 16) - parseInt(b.nonce, 16)
    }
    return sortDir === 'desc' ? -cmp : cmp
  })

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'desc' ? ' \u25BC' : ' \u25B2') : ''

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

      {/* Tabs + Controls */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold">Transactions</h2>
            <div className="flex gap-1 ml-4">
              {(['pending', 'queued'] as PoolTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 text-sm rounded ${
                    tab === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)} ({t === 'pending' ? pendingCount : queuedCount})
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={filterSender}
              onChange={(e) => setFilterSender(e.target.value)}
              placeholder="Filter by sender..."
              className="px-3 py-1.5 border rounded text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              onClick={() => void load()}
              disabled={loading}
              className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>

        {txs.length === 0 ? (
          <p className="text-gray-500 text-sm">
            {loading ? 'Loading...' : `No ${tab} transactions in the mempool.`}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Hash</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">From</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">To</th>
                  <th
                    className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-blue-600"
                    onClick={() => toggleSort('value')}
                  >
                    Value{sortIndicator('value')}
                  </th>
                  <th
                    className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-blue-600"
                    onClick={() => toggleSort('nonce')}
                  >
                    Nonce{sortIndicator('nonce')}
                  </th>
                  <th
                    className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-blue-600"
                    onClick={() => toggleSort('gasPrice')}
                  >
                    Gas Price{sortIndicator('gasPrice')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {txs.map((tx) => {
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
