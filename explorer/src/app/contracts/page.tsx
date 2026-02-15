'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { rpcCall } from '@/lib/rpc'
import { formatAddress } from '@/lib/provider'

interface ContractInfo {
  address: string
  creator: string
  blockNumber: number
  txHash: string
  codeSize: number
  deployedAt?: number
}

export default function ContractsPage() {
  const [contracts, setContracts] = useState<ContractInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const pageSize = 25

  useEffect(() => {
    void loadContracts(0)
  }, [])

  async function loadContracts(offset: number) {
    setLoading(true)
    try {
      // Try indexed lookup first (fast)
      const indexed = await rpcCall<Array<{
        address: string
        creator: string
        blockNumber: string
        txHash: string
        deployedAt: number
      }>>('coc_getContracts', [{ limit: pageSize, offset, reverse: true }]).catch(() => null)

      if (indexed && indexed.length > 0) {
        const enriched = await Promise.all(
          indexed.map(async (c) => {
            const blockNum = parseInt(c.blockNumber, 16)
            const code = await rpcCall<string>('eth_getCode', [c.address, 'latest']).catch(() => '0x')
            return {
              address: c.address,
              creator: c.creator,
              blockNumber: blockNum,
              txHash: c.txHash,
              codeSize: (code.length - 2) / 2,
              deployedAt: c.deployedAt,
            }
          }),
        )
        setContracts(enriched)
        setPage(offset)
      } else {
        // Fallback: scan recent blocks
        await scanForContracts()
      }
    } catch {
      await scanForContracts()
    }
    setLoading(false)
  }

  async function scanForContracts() {
    const heightHex = await rpcCall<string>('eth_blockNumber')
    const height = parseInt(heightHex, 16)
    const fromBlock = Math.max(0, height - 100)
    const found: ContractInfo[] = []

    for (let n = height; n >= fromBlock && found.length < pageSize; n--) {
      const blockHex = `0x${n.toString(16)}`
      const block = await rpcCall<{
        transactions: Array<{ hash: string; from: string; to: string | null; input: string }> | string[]
      }>('eth_getBlockByNumber', [blockHex, true]).catch(() => null)

      if (!block?.transactions) continue
      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue
        if (tx.to === null && tx.input && tx.input.length > 10) {
          const receipt = await rpcCall<{
            contractAddress?: string; status: string
          }>('eth_getTransactionReceipt', [tx.hash]).catch(() => null)
          if (receipt?.contractAddress && receipt.status === '0x1') {
            const code = await rpcCall<string>('eth_getCode', [receipt.contractAddress, 'latest']).catch(() => '0x')
            found.push({
              address: receipt.contractAddress,
              creator: tx.from,
              blockNumber: n,
              txHash: tx.hash,
              codeSize: (code.length - 2) / 2,
            })
          }
        }
      }
    }
    setContracts(found)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Deployed Contracts</h2>
        <button
          onClick={() => void loadContracts(0)}
          disabled={loading}
          className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          Loading contracts...
        </div>
      ) : contracts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          No contracts found.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-3 bg-gray-50 text-sm text-gray-500">
            {contracts.length} contract(s) {page > 0 && `(page ${Math.floor(page / pageSize) + 1})`}
          </div>
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Contract</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Creator</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Block</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tx</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Size</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Deployed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {contracts.map((c) => (
                <tr key={c.address} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    <Link href={`/address/${c.address}`} className="text-blue-600 hover:text-blue-800 font-mono">
                      {formatAddress(c.address)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <Link href={`/address/${c.creator}`} className="text-blue-600 hover:text-blue-800 font-mono">
                      {formatAddress(c.creator)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <Link href={`/block/${c.blockNumber}`} className="text-blue-600 hover:text-blue-800">
                      #{c.blockNumber.toLocaleString()}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <Link href={`/tx/${c.txHash}`} className="text-blue-600 hover:text-blue-800 font-mono">
                      {c.txHash.slice(0, 10)}...
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600">
                    {c.codeSize.toLocaleString()} B
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {c.deployedAt ? new Date(c.deployedAt).toLocaleString() : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-between px-4 py-3 border-t">
            <button
              onClick={() => void loadContracts(Math.max(0, page - pageSize))}
              disabled={loading || page === 0}
              className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => void loadContracts(page + pageSize)}
              disabled={loading || contracts.length < pageSize}
              className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
