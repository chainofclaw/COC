'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { rpcCall } from '@/lib/rpc'
import { formatAddress } from '@/lib/provider'

interface ContractInfo {
  address: string
  creator: string
  blockNumber: number
  txHash: string
  codeSize?: number
  deployedAt?: number
}

type LoadMode = 'idle' | 'loading-index' | 'scanning' | 'enriching'

// Limits: keep scan work bounded so public-RPC RTT doesn't compound into minutes.
const SCAN_MAX_BLOCKS = 100
const SCAN_BLOCK_CONCURRENCY = 10
const ENRICH_CONCURRENCY = 8
const OVERALL_TIMEOUT_MS = 20_000
const RPC_TIMEOUT_MS = 4_000

// Wrap rpcCall with a per-call timeout so a single slow peer can't stall the page.
async function rpc<T>(method: string, params: unknown[] = [], timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    rpcCall<T>(method, params),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), timeoutMs),
    ),
  ])
}

// Run async jobs with a fixed concurrency cap. Plain Promise.all on hundreds of
// eth_getBlockByNumber calls saturates the connection pool and a single public
// gateway's rate limiter; batching keeps the request fan-out predictable.
async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      const item = items[i]!
      out[i] = await worker(item, i)
    }
  })
  await Promise.all(runners)
  return out
}

export default function ContractsPage() {
  const [contracts, setContracts] = useState<ContractInfo[]>([])
  const [mode, setMode] = useState<LoadMode>('idle')
  const [page, setPage] = useState(0)
  const [indexEnabled, setIndexEnabled] = useState<boolean | null>(null)
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pageSize = 25

  useEffect(() => {
    void loadContracts(0)
    return () => abortRef.current?.abort()
  }, [])

  async function loadContracts(offset: number) {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setErrorMsg(null)
    setMode('loading-index')
    setScanProgress(null)

    // Overall deadline — tight enough that the UI recovers even if the RPC hangs.
    const deadline = setTimeout(() => ctrl.abort(), OVERALL_TIMEOUT_MS)

    try {
      // Probe index availability first. Falls back to treating absence as unknown
      // (older nodes won't have this method yet).
      const status = await rpc<{ enabled: boolean }>('coc_blockIndexStatus').catch(() => null)
      if (ctrl.signal.aborted) return
      setIndexEnabled(status?.enabled ?? null)

      const indexed = await rpc<Array<{
        address: string
        creator: string
        blockNumber: string
        txHash: string
        deployedAt: number
      }>>('coc_getContracts', [{ limit: pageSize, offset, reverse: true }]).catch(() => null)
      if (ctrl.signal.aborted) return

      if (indexed && indexed.length > 0) {
        // Render rows immediately with unknown size, then enrich in parallel so
        // users see the addresses right away instead of waiting for 25 × eth_getCode.
        const baseRows: ContractInfo[] = indexed.map((c) => ({
          address: c.address,
          creator: c.creator,
          blockNumber: parseInt(c.blockNumber, 16),
          txHash: c.txHash,
          deployedAt: c.deployedAt,
          codeSize: undefined,
        }))
        setContracts(baseRows)
        setPage(offset)
        setMode('enriching')

        const enriched = await parallelMap(baseRows, ENRICH_CONCURRENCY, async (row) => {
          const code = await rpc<string>('eth_getCode', [row.address, 'latest']).catch(() => '0x')
          return { ...row, codeSize: Math.max(0, (code.length - 2) / 2) }
        })
        if (ctrl.signal.aborted) return
        setContracts(enriched)
      } else if (status?.enabled === false) {
        // Node explicitly has no block index — skip scan entirely, it wouldn't be
        // authoritative anyway and on a public gateway would take minutes.
        setContracts([])
        setErrorMsg('Block index is not enabled on this node. Contract history is unavailable.')
      } else if (offset > 0) {
        // Empty page beyond offset 0 just means we've paginated past the last entry.
        setContracts([])
      } else {
        // Index is empty (enabled===true) or indeterminate (status===null on older
        // nodes): best-effort scan of recent blocks as a fallback.
        setMode('scanning')
        await scanForContracts(ctrl)
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setErrorMsg(err instanceof Error ? err.message : 'load failed')
      }
    } finally {
      clearTimeout(deadline)
      if (abortRef.current === ctrl) abortRef.current = null
      setMode('idle')
    }
  }

  async function scanForContracts(ctrl: AbortController) {
    const heightHex = await rpc<string>('eth_blockNumber').catch(() => null)
    if (!heightHex || ctrl.signal.aborted) {
      setContracts([])
      return
    }
    const height = parseInt(heightHex, 16)
    const fromBlock = Math.max(0, height - SCAN_MAX_BLOCKS + 1)
    const blockNums: number[] = []
    for (let n = height; n >= fromBlock; n--) blockNums.push(n)
    setScanProgress({ done: 0, total: blockNums.length })

    let done = 0
    const blocks = await parallelMap(blockNums, SCAN_BLOCK_CONCURRENCY, async (n) => {
      if (ctrl.signal.aborted) return null
      const blockHex = `0x${n.toString(16)}`
      const block = await rpc<{
        transactions: Array<{ hash: string; from: string; to: string | null; input: string }> | string[]
      }>('eth_getBlockByNumber', [blockHex, true]).catch(() => null)
      done++
      setScanProgress({ done, total: blockNums.length })
      return { n, block }
    })
    if (ctrl.signal.aborted) return

    // Gather contract-creation txs across blocks, then fetch receipts+code in
    // parallel. Separating the fan-out phases keeps peak concurrency bounded.
    const creations: Array<{ n: number; hash: string; from: string }> = []
    for (const item of blocks) {
      if (!item?.block?.transactions) continue
      for (const tx of item.block.transactions) {
        if (typeof tx === 'string') continue
        if (tx.to === null && tx.input && tx.input.length > 10) {
          creations.push({ n: item.n, hash: tx.hash, from: tx.from })
        }
      }
    }

    const found: ContractInfo[] = []
    await parallelMap(creations, ENRICH_CONCURRENCY, async (c) => {
      if (ctrl.signal.aborted) return
      const receipt = await rpc<{ contractAddress?: string; status: string }>(
        'eth_getTransactionReceipt',
        [c.hash],
      ).catch(() => null)
      if (!receipt?.contractAddress || receipt.status !== '0x1') return
      const code = await rpc<string>('eth_getCode', [receipt.contractAddress, 'latest']).catch(() => '0x')
      found.push({
        address: receipt.contractAddress,
        creator: c.from,
        blockNumber: c.n,
        txHash: c.hash,
        codeSize: Math.max(0, (code.length - 2) / 2),
      })
    })
    if (ctrl.signal.aborted) return

    found.sort((a, b) => b.blockNumber - a.blockNumber)
    setContracts(found.slice(0, pageSize))
  }

  const loading = mode !== 'idle'
  const statusText =
    mode === 'loading-index' ? 'Querying contract index…'
    : mode === 'scanning' ? `Scanning recent blocks… ${scanProgress ? `(${scanProgress.done}/${scanProgress.total})` : ''}`
    : mode === 'enriching' ? 'Loading contract metadata…'
    : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Deployed Contracts</h2>
        <button
          onClick={() => void loadContracts(0)}
          disabled={loading}
          className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {indexEnabled === false && !errorMsg && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-2 text-sm text-yellow-800">
          This node does not maintain a block index. Showing best-effort scan of recent blocks only.
        </div>
      )}

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-800">
          {errorMsg}
        </div>
      )}

      {loading && contracts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          {statusText ?? 'Loading contracts…'}
        </div>
      ) : !loading && contracts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          No contracts found.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-3 bg-gray-50 text-sm text-gray-500 flex items-center justify-between">
            <span>
              {contracts.length} contract(s) {page > 0 && `(page ${Math.floor(page / pageSize) + 1})`}
            </span>
            {statusText && <span className="text-xs text-blue-600">{statusText}</span>}
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
                      {c.txHash.slice(0, 10)}…
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600">
                    {c.codeSize === undefined ? <span className="text-gray-400">…</span> : `${c.codeSize.toLocaleString()} B`}
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
