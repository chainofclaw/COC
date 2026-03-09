'use client'

import { useState } from 'react'
import Link from 'next/link'

export default function VerifyPage() {
  const [address, setAddress] = useState('')
  const [sourceCode, setSourceCode] = useState('')
  const [compilerVersion, setCompilerVersion] = useState('0.8.28')
  const [optimize, setOptimize] = useState(true)
  const [optimizeRuns, setOptimizeRuns] = useState(200)
  const [contractName, setContractName] = useState('')
  const [result, setResult] = useState<{
    verified: boolean
    matchPct: number
    error?: string
  } | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)

    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          sourceCode,
          compilerVersion,
          optimize,
          optimizeRuns,
          contractName: contractName || undefined,
        }),
      })
      const data = await res.json()
      setResult(data)
    } catch (err) {
      setResult({
        verified: false,
        matchPct: 0,
        error: err instanceof Error ? err.message : 'Verification request failed',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-blue-600 hover:underline text-sm">&larr; Home</Link>
        <h1 className="text-2xl font-bold">Contract Verification</h1>
      </div>

      <form onSubmit={handleVerify} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Contract Address</label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="0x..."
            className="w-full p-2 border rounded font-mono text-sm"
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Compiler Version</label>
            <select
              value={compilerVersion}
              onChange={e => setCompilerVersion(e.target.value)}
              className="w-full p-2 border rounded text-sm"
            >
              <option value="0.8.28">0.8.28</option>
              <option value="0.8.27">0.8.27</option>
              <option value="0.8.26">0.8.26</option>
              <option value="0.8.24">0.8.24</option>
              <option value="0.8.20">0.8.20</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Optimization</label>
            <label className="flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                checked={optimize}
                onChange={e => setOptimize(e.target.checked)}
              />
              <span className="text-sm">Enable</span>
              {optimize && (
                <input
                  type="number"
                  value={optimizeRuns}
                  onChange={e => setOptimizeRuns(Number(e.target.value))}
                  className="w-20 p-1 border rounded text-sm ml-2"
                  min={1}
                />
              )}
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Contract Name (optional)</label>
            <input
              type="text"
              value={contractName}
              onChange={e => setContractName(e.target.value)}
              placeholder="MyContract"
              className="w-full p-2 border rounded text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Solidity Source Code</label>
          <textarea
            value={sourceCode}
            onChange={e => setSourceCode(e.target.value)}
            placeholder="// SPDX-License-Identifier: MIT&#10;pragma solidity ^0.8.0;&#10;&#10;contract MyContract { ... }"
            className="w-full h-64 p-3 border rounded font-mono text-sm"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Verifying...' : 'Verify Contract'}
        </button>
      </form>

      {result && (
        <div className={`mt-6 p-4 rounded border ${result.verified ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <h2 className={`font-bold text-lg ${result.verified ? 'text-green-700' : 'text-red-700'}`}>
            {result.verified ? 'Verification Successful' : 'Verification Failed'}
          </h2>
          {result.matchPct > 0 && (
            <p className="text-sm mt-1">Bytecode match: {result.matchPct}%</p>
          )}
          {result.error && (
            <p className="text-sm mt-1 text-red-600">{result.error}</p>
          )}
        </div>
      )}
    </div>
  )
}
