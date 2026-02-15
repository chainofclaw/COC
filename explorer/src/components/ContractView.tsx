'use client'

import { useState } from 'react'
import Link from 'next/link'
import { formatAddress } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'
import { decodeMethodSelector } from '@/lib/decoder'

interface ContractViewProps {
  address: string
  code: string
}

export function ContractView({ address, code }: ContractViewProps) {
  const [codeExpanded, setCodeExpanded] = useState(false)

  return (
    <div className="space-y-6">
      {/* Bytecode */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">Contract Bytecode</h3>
          <button
            onClick={() => setCodeExpanded(!codeExpanded)}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            {codeExpanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
        <div className="bg-gray-50 p-4 rounded">
          <pre className={`text-xs font-mono break-all whitespace-pre-wrap ${
            codeExpanded ? '' : 'max-h-32 overflow-hidden'
          }`}>
            {code}
          </pre>
          {!codeExpanded && code.length > 500 && (
            <div className="text-center mt-2">
              <span className="text-xs text-gray-400">... {(code.length - 2) / 2} bytes total</span>
            </div>
          )}
        </div>
        <div className="mt-3 text-sm text-gray-600">
          Bytecode Size: {(code.length - 2) / 2} bytes
        </div>
      </div>

      {/* Contract Call Interface */}
      <ContractCall address={address} />

      {/* Storage Reader */}
      <StorageReader address={address} />

      {/* Contract Events */}
      <ContractEvents address={address} />
    </div>
  )
}

// Read-only contract call interface
function ContractCall({ address }: { address: string }) {
  const [callData, setCallData] = useState('')
  const [from, setFrom] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Quick-call presets for common view functions
  const presets = [
    { label: 'name()', data: '0x06fdde03' },
    { label: 'symbol()', data: '0x95d89b41' },
    { label: 'decimals()', data: '0x313ce567' },
    { label: 'totalSupply()', data: '0x18160ddd' },
    { label: 'owner()', data: '0x8da5cb5b' },
    { label: 'paused()', data: '0x5c975abb' },
  ]

  async function executeCall() {
    if (!callData) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const params: Record<string, string> = { to: address, data: callData }
      if (from) params.from = from
      const res = await rpcCall<string>('eth_call', [params, 'latest'])
      setResult(res)
    } catch (err) {
      setError(String(err))
    }
    setLoading(false)
  }

  const decoded = decodeMethodSelector(callData)

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-xl font-bold mb-4">Contract Read (eth_call)</h3>

      {/* Quick presets */}
      <div className="mb-4">
        <div className="text-xs text-gray-500 mb-2">Quick call:</div>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.data}
              onClick={() => { setCallData(p.data); setResult(null); setError(null) }}
              className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded font-mono"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">From (optional)</label>
          <input
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="0x..."
            className="w-full px-3 py-2 border rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">
            Call Data (hex)
            {decoded && (
              <span className="ml-2 px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">
                {decoded.name}
              </span>
            )}
          </label>
          <input
            type="text"
            value={callData}
            onChange={(e) => setCallData(e.target.value)}
            placeholder="0x06fdde03"
            className="w-full px-3 py-2 border rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <button
          onClick={executeCall}
          disabled={loading || !callData}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Calling...' : 'Execute Call'}
        </button>
      </div>

      {result !== null && (
        <div className="mt-4 bg-green-50 border border-green-200 p-4 rounded">
          <div className="text-xs text-green-700 font-medium mb-1">Result:</div>
          <code className="text-sm font-mono break-all">{result}</code>
          {result.length === 66 && result !== '0x' + '0'.repeat(64) && (
            <div className="mt-2 text-xs text-gray-500">
              As address: {formatAddress('0x' + result.slice(26))} |
              As uint256: {BigInt(result).toString()}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 p-4 rounded">
          <div className="text-xs text-red-700 font-medium mb-1">Error:</div>
          <code className="text-sm font-mono break-all text-red-600">{error}</code>
        </div>
      )}
    </div>
  )
}

function StorageReader({ address }: { address: string }) {
  const [slot, setSlot] = useState('0')
  const [value, setValue] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function readSlot() {
    setLoading(true)
    try {
      const slotHex = slot.startsWith('0x') ? slot : `0x${parseInt(slot).toString(16)}`
      const result = await rpcCall<string>('eth_getStorageAt', [address, slotHex, 'latest'])
      setValue(result)
    } catch (err) {
      setValue(`Error: ${err}`)
    }
    setLoading(false)
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-xl font-bold mb-4">Storage Reader</h3>
      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-600 mb-1">Slot Number</label>
          <input
            type="text"
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2 border rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <button
          onClick={readSlot}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Reading...' : 'Read'}
        </button>
      </div>
      {value !== null && (
        <div className="mt-4 bg-gray-50 p-4 rounded">
          <div className="text-xs text-gray-500 mb-1">Value:</div>
          <code className="text-sm font-mono break-all">{value}</code>
        </div>
      )}
    </div>
  )
}

interface LogEntry {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: number
}

function ContractEvents({ address }: { address: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  async function loadEvents() {
    setLoading(true)
    try {
      const result = await rpcCall<LogEntry[]>('eth_getLogs', [{
        address,
        fromBlock: '0x0',
        toBlock: 'latest',
      }])
      setLogs(Array.isArray(result) ? result : [])
      setLoaded(true)
    } catch {
      setLogs([])
      setLoaded(true)
    }
    setLoading(false)
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold">Contract Events</h3>
        {!loaded && (
          <button
            onClick={loadEvents}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Load Events'}
          </button>
        )}
      </div>

      {loaded && logs.length === 0 && (
        <p className="text-gray-500 text-sm">No events found for this contract.</p>
      )}

      {logs.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm text-gray-600 mb-2">{logs.length} event(s) found</div>
          {logs.map((log, i) => (
            <div key={i} className="bg-gray-50 p-4 rounded text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-gray-400">Log #{log.logIndex ?? i}</span>
                {log.transactionHash && (
                  <Link href={`/tx/${log.transactionHash}`} className="text-xs text-blue-600 hover:text-blue-800 font-mono">
                    {log.transactionHash.slice(0, 14)}...
                  </Link>
                )}
              </div>
              {log.blockNumber && (
                <div>
                  <span className="font-medium text-xs">Block:</span>{' '}
                  <Link href={`/block/${parseInt(String(log.blockNumber), 16)}`} className="text-blue-600 text-xs">
                    #{typeof log.blockNumber === 'string' ? parseInt(log.blockNumber, 16) : Number(log.blockNumber)}
                  </Link>
                </div>
              )}
              <div>
                <span className="font-medium text-xs">Topics:</span>
                <div className="mt-1 space-y-1">
                  {log.topics.map((topic, j) => (
                    <div key={j} className="text-xs font-mono bg-white p-1.5 rounded truncate">{topic}</div>
                  ))}
                </div>
              </div>
              {log.data && log.data !== '0x' && (
                <div>
                  <span className="font-medium text-xs">Data:</span>
                  <div className="text-xs font-mono bg-white p-1.5 rounded mt-1 break-all">{log.data}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
