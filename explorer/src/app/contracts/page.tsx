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
}

export default function ContractsPage() {
  const [contracts, setContracts] = useState<ContractInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [scanRange, setScanRange] = useState(100)

  useEffect(() => {
    void scanForContracts()
  }, [])

  async function scanForContracts() {
    setLoading(true)
    try {
      const heightHex = await rpcCall<string>('eth_blockNumber')
      const height = parseInt(heightHex, 16)
      const fromBlock = Math.max(0, height - scanRange)
      const found: ContractInfo[] = []

      // Scan recent blocks for contract creation txs (to = null)
      for (let n = height; n >= fromBlock && found.length < 50; n--) {
        const blockHex = `0x${n.toString(16)}`
        const block = await rpcCall<{
          number: string
          transactions: Array<{
            hash: string
            from: string
            to: string | null
            input: string
          }> | string[]
        }>('eth_getBlockByNumber', [blockHex, true]).catch(() => null)

        if (!block?.transactions) continue

        for (const tx of block.transactions) {
          if (typeof tx === 'string') continue
          // Contract creation: to is null and input has code
          if (tx.to === null && tx.input && tx.input.length > 10) {
            // Get the created contract address from receipt
            const receipt = await rpcCall<{
              contractAddress?: string
              status: string
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
    } catch (err) {
      console.error('scan failed:', err)
    }
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Deployed Contracts</h2>
        <div className="flex items-center gap-3">
          <select
            value={scanRange}
            onChange={(e) => setScanRange(parseInt(e.target.value))}
            className="px-3 py-1.5 border rounded text-sm"
          >
            <option value="50">Last 50 blocks</option>
            <option value="100">Last 100 blocks</option>
            <option value="500">Last 500 blocks</option>
            <option value="1000">Last 1000 blocks</option>
          </select>
          <button
            onClick={() => void scanForContracts()}
            disabled={loading}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Scanning...' : 'Rescan'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          Scanning blocks for contract deployments...
        </div>
      ) : contracts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          No contract deployments found in the last {scanRange} blocks.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-3 bg-gray-50 text-sm text-gray-500">
            {contracts.length} contract(s) found
          </div>
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Contract</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Creator</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Block</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tx</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Size</th>
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
                    {c.codeSize.toLocaleString()} bytes
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
