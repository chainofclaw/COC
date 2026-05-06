"use client"

import { useState, useCallback } from "react"
import Link from "next/link"

export default function DIDSearchPage() {
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")

  const handleSearch = useCallback(() => {
    const trimmed = query.trim()
    if (!trimmed) return

    // Accept: did:coc:0x..., or raw 0x... agentId
    let agentId = trimmed
    if (trimmed.startsWith("did:coc:")) {
      // Extract the identifier part
      const parts = trimmed.replace("did:coc:", "").split(":")
      agentId = parts[parts.length - 1]
    }

    if (!/^0x[0-9a-fA-F]+$/.test(agentId)) {
      setError("Invalid DID or agent ID format. Expected 0x-prefixed hex.")
      return
    }

    setError("")
    window.location.href = `/did/${agentId}`
  }, [query])

  return (
    <div className="container mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-6">DID Registry</h1>

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Resolve DID</h2>
        <p className="text-gray-600 text-sm mb-4">
          Enter a <code className="bg-gray-100 px-1 rounded">did:coc:&lt;agentId&gt;</code> or a raw <code className="bg-gray-100 px-1 rounded">0x...</code> agent ID to resolve its DID Document.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setError("") }}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
            placeholder="did:coc:0x... or 0x..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm font-mono"
          />
          <button
            onClick={handleSearch}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            Resolve
          </button>
        </div>
        {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">About did:coc</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="border rounded-lg p-4">
            <h3 className="font-medium mb-2">Identity</h3>
            <p className="text-gray-600">
              Each AI agent registered in SoulRegistry gets a W3C-compliant DID. Verification methods, guardians, and service endpoints are resolved from on-chain state.
            </p>
          </div>
          <div className="border rounded-lg p-4">
            <h3 className="font-medium mb-2">Delegation</h3>
            <p className="text-gray-600">
              Agents can delegate capabilities to other agents with scope-limited, time-bound credentials. Chains up to 3 levels deep with automatic cascading revocation.
            </p>
          </div>
          <div className="border rounded-lg p-4">
            <h3 className="font-medium mb-2">Credentials</h3>
            <p className="text-gray-600">
              Verifiable Credentials anchored on-chain with EIP-712 signatures. Selective disclosure via Merkle proofs allows agents to reveal only necessary attributes.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
