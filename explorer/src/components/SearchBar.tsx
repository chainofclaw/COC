'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function SearchBar() {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const router = useRouter()

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q || searching) return

    // Block number
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

    // 0x + 64 hex: could be tx hash or block hash
    if (/^0x[a-fA-F0-9]{64}$/.test(q)) {
      // Try tx first (most common search)
      router.push(`/tx/${q}`)
      setQuery('')
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
    <form onSubmit={handleSearch} className="flex-1 max-w-md">
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
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </div>
    </form>
  )
}
