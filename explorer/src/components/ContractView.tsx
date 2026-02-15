'use client'

import { useState } from 'react'
import Link from 'next/link'
import { RPC_URL, formatAddress } from '@/lib/provider'
import { rpcCall } from '@/lib/rpc'

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

      {/* Storage Reader */}
      <StorageReader address={address} />

      {/* Contract Events */}
      <ContractEvents address={address} />
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
