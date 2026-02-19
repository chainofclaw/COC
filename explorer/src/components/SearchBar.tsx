'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:18780'

async function rpcCheck(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
  })
  const json = await res.json()
  return json.result
}

export function SearchBar() {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const router = useRouter()

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q || searching) return

    // Block number (decimal)
    if (/^\d+$/.test(q)) {
      router.push(`/block/${q}`)
      setQuery('')
      return
    }

    // Address (0x + 40 hex)
    if (/^0x[a-fA-F0-9]{40}$/.test(q)) {
      router.push(`/address/${q}`)
      setQuery('')
      return
    }

    // 0x + 64 hex: could be tx hash or block hash — disambiguate via RPC
    if (/^0x[a-fA-F0-9]{64}$/.test(q)) {
      setSearching(true)
      try {
        // Try tx first (most common search)
        const tx = await rpcCheck('eth_getTransactionByHash', [q])
        if (tx) {
          router.push(`/tx/${q}`)
          setQuery('')
          return
        }
        // Try block hash
        const block = await rpcCheck('eth_getBlockByHash', [q, false])
        if (block) {
          const blockNum = parseInt((block as Record<string, string>).number ?? '0', 16)
          router.push(`/block/${blockNum}`)
          setQuery('')
          return
        }
        // Not found — default to tx page (will show not found)
        router.push(`/tx/${q}`)
        setQuery('')
      } finally {
        setSearching(false)
      }
      return
    }

    // Short hex (block number in hex)
    if (/^0x[a-fA-F0-9]+$/.test(q)) {
      const num = parseInt(q, 16)
      if (!isNaN(num)) {
        router.push(`/block/${num}`)
        setQuery('')
        return
      }
    }
  }

  return (
    <form onSubmit={handleSearch} className="flex-1 w-full sm:max-w-md">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by Address / Tx Hash / Block"
          className="w-full px-4 py-2 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <button
          type="submit"
          disabled={searching}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        >
          {searching ? (
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
        </button>
      </div>
    </form>
  )
}
