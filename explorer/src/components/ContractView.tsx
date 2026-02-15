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
  const [showOpcodes, setShowOpcodes] = useState(false)

  return (
    <div className="space-y-6">
      {/* Bytecode */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">Contract Bytecode</h3>
          <div className="flex gap-2">
            <button
              onClick={() => setShowOpcodes(!showOpcodes)}
              className="text-sm text-purple-600 hover:text-purple-800"
            >
              {showOpcodes ? 'Hex' : 'Opcodes'}
            </button>
            <button
              onClick={() => setCodeExpanded(!codeExpanded)}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              {codeExpanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
        </div>
        <div className="bg-gray-50 p-4 rounded">
          {showOpcodes ? (
            <pre className={`text-xs font-mono break-all whitespace-pre-wrap ${
              codeExpanded ? '' : 'max-h-48 overflow-hidden'
            }`}>
              {disassemble(code)}
            </pre>
          ) : (
            <pre className={`text-xs font-mono break-all whitespace-pre-wrap ${
              codeExpanded ? '' : 'max-h-32 overflow-hidden'
            }`}>
              {code}
            </pre>
          )}
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

      {/* Contract Call History */}
      <ContractCallHistory address={address} />

      {/* Contract Call Interface */}
      <ContractCall address={address} />

      {/* Storage Scanner */}
      <StorageScanner address={address} />

      {/* Contract Events */}
      <ContractEvents address={address} />
    </div>
  )
}

// Contract transaction (call) history
function ContractCallHistory({ address }: { address: string }) {
  const [txs, setTxs] = useState<Array<{
    hash: string; from: string; to: string | null
    blockNumber: string; gasUsed: string; status: string; input: string
  }>>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const pageSize = 20

  async function loadHistory(offset = 0) {
    setLoading(true)
    try {
      const result = await rpcCall<typeof txs>('coc_getTransactionsByAddress', [
        address, pageSize, true, offset,
      ])
      setTxs(Array.isArray(result) ? result : [])
      setPage(offset)
      setLoaded(true)
    } catch {
      setTxs([])
      setLoaded(true)
    }
    setLoading(false)
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold">Call History</h3>
        {!loaded && (
          <button
            onClick={() => loadHistory(0)}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Load History'}
          </button>
        )}
      </div>

      {loaded && txs.length === 0 && (
        <p className="text-gray-500 text-sm">No transactions found for this contract.</p>
      )}

      {txs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="pb-2 pr-4">Tx Hash</th>
                <th className="pb-2 pr-4">Block</th>
                <th className="pb-2 pr-4">From</th>
                <th className="pb-2 pr-4">Method</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2">Gas Used</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((tx) => {
                const method = decodeMethodSelector(tx.input)
                const blockNum = typeof tx.blockNumber === 'string' && tx.blockNumber.startsWith('0x')
                  ? parseInt(tx.blockNumber, 16) : Number(tx.blockNumber)
                const gasUsed = typeof tx.gasUsed === 'string' && tx.gasUsed.startsWith('0x')
                  ? parseInt(tx.gasUsed, 16) : Number(tx.gasUsed)
                const success = tx.status === '0x1' || tx.status === '1'
                return (
                  <tr key={tx.hash} className="border-b hover:bg-gray-50">
                    <td className="py-2 pr-4">
                      <Link href={`/tx/${tx.hash}`} className="text-blue-600 hover:text-blue-800 font-mono text-xs">
                        {tx.hash.slice(0, 14)}...
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <Link href={`/block/${blockNum}`} className="text-blue-600 hover:text-blue-800 text-xs">
                        #{blockNum}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      <Link href={`/address/${tx.from}`} className="text-blue-600 hover:text-blue-800">
                        {formatAddress(tx.from)}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">
                        {method?.name?.split('(')[0] ?? (tx.input === '0x' ? 'transfer' : tx.input.slice(0, 10))}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs ${success ? 'text-green-600' : 'text-red-600'}`}>
                        {success ? 'Success' : 'Failed'}
                      </span>
                    </td>
                    <td className="py-2 text-xs text-gray-600">{gasUsed.toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex justify-between mt-4">
            <button
              onClick={() => loadHistory(Math.max(0, page - pageSize))}
              disabled={loading || page === 0}
              className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => loadHistory(page + pageSize)}
              disabled={loading || txs.length < pageSize}
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
          {/* Try to decode as UTF-8 string (ABI-encoded) */}
          {result.length > 130 && (
            <div className="mt-2 text-xs text-gray-500">
              As string: {tryDecodeAbiString(result)}
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

// Enhanced storage scanner with multi-slot read and value interpretation
function StorageScanner({ address }: { address: string }) {
  const [slot, setSlot] = useState('0')
  const [results, setResults] = useState<Array<{ slot: string; value: string }>>([])
  const [loading, setLoading] = useState(false)
  const [scanCount, setScanCount] = useState(8)

  async function readSlot() {
    setLoading(true)
    try {
      const slotHex = slot.startsWith('0x') ? slot : `0x${parseInt(slot).toString(16)}`
      const result = await rpcCall<string>('eth_getStorageAt', [address, slotHex, 'latest'])
      setResults([{ slot: slotHex, value: result }])
    } catch (err) {
      setResults([{ slot, value: `Error: ${err}` }])
    }
    setLoading(false)
  }

  async function scanSlots() {
    setLoading(true)
    const startSlot = slot.startsWith('0x') ? parseInt(slot, 16) : parseInt(slot)
    const items: Array<{ slot: string; value: string }> = []

    for (let i = 0; i < scanCount; i++) {
      try {
        const s = `0x${(startSlot + i).toString(16)}`
        const val = await rpcCall<string>('eth_getStorageAt', [address, s, 'latest'])
        items.push({ slot: s, value: val })
      } catch {
        break
      }
    }
    setResults(items)
    setLoading(false)
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-xl font-bold mb-4">Storage Scanner</h3>
      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-[120px]">
          <label className="block text-sm font-medium text-gray-600 mb-1">Start Slot</label>
          <input
            type="text"
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2 border rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div className="w-20">
          <label className="block text-sm font-medium text-gray-600 mb-1">Count</label>
          <select
            value={scanCount}
            onChange={(e) => setScanCount(parseInt(e.target.value))}
            className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            <option value="1">1</option>
            <option value="4">4</option>
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
          </select>
        </div>
        <button
          onClick={readSlot}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Reading...' : 'Read'}
        </button>
        <button
          onClick={scanSlots}
          disabled={loading}
          className="px-4 py-2 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
        >
          {loading ? 'Scanning...' : 'Scan Range'}
        </button>
      </div>

      {results.length > 0 && (
        <div className="mt-4 space-y-2">
          {results.map((r, i) => {
            const isEmpty = r.value === '0x' + '0'.repeat(64)
            return (
              <div key={i} className={`p-3 rounded text-sm ${isEmpty ? 'bg-gray-50' : 'bg-blue-50 border border-blue-200'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-gray-500">Slot {r.slot}:</span>
                  {isEmpty && <span className="text-xs text-gray-400">(empty)</span>}
                </div>
                <code className="text-xs font-mono break-all">{r.value}</code>
                {!isEmpty && !r.value.startsWith('Error') && (
                  <div className="mt-1 text-xs text-gray-500 space-x-3">
                    <span>uint256: {BigInt(r.value).toString()}</span>
                    {r.value.slice(0, 26) === '0x000000000000000000000000' && (
                      <span>addr: {formatAddress('0x' + r.value.slice(26))}</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
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

// Try to decode ABI-encoded string from eth_call result
function tryDecodeAbiString(hex: string): string {
  try {
    if (!hex || hex.length < 130) return ''
    // ABI string: offset (32 bytes) + length (32 bytes) + data
    const lenHex = hex.slice(66, 130)
    const len = parseInt(lenHex, 16)
    if (len <= 0 || len > 256) return '(not a string)'
    const dataHex = hex.slice(130, 130 + len * 2)
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16)
    }
    const decoded = new TextDecoder().decode(bytes)
    // Only return if printable
    if (/^[\x20-\x7E]+$/.test(decoded)) return `"${decoded}"`
    return '(binary data)'
  } catch {
    return ''
  }
}

// EVM opcode table (most common opcodes)
const OPCODES: Record<number, string> = {
  0x00: 'STOP', 0x01: 'ADD', 0x02: 'MUL', 0x03: 'SUB', 0x04: 'DIV',
  0x05: 'SDIV', 0x06: 'MOD', 0x07: 'SMOD', 0x08: 'ADDMOD', 0x09: 'MULMOD',
  0x0a: 'EXP', 0x0b: 'SIGNEXTEND',
  0x10: 'LT', 0x11: 'GT', 0x12: 'SLT', 0x13: 'SGT', 0x14: 'EQ',
  0x15: 'ISZERO', 0x16: 'AND', 0x17: 'OR', 0x18: 'XOR', 0x19: 'NOT',
  0x1a: 'BYTE', 0x1b: 'SHL', 0x1c: 'SHR', 0x1d: 'SAR',
  0x20: 'SHA3',
  0x30: 'ADDRESS', 0x31: 'BALANCE', 0x32: 'ORIGIN', 0x33: 'CALLER',
  0x34: 'CALLVALUE', 0x35: 'CALLDATALOAD', 0x36: 'CALLDATASIZE',
  0x37: 'CALLDATACOPY', 0x38: 'CODESIZE', 0x39: 'CODECOPY',
  0x3a: 'GASPRICE', 0x3b: 'EXTCODESIZE', 0x3c: 'EXTCODECOPY',
  0x3d: 'RETURNDATASIZE', 0x3e: 'RETURNDATACOPY', 0x3f: 'EXTCODEHASH',
  0x40: 'BLOCKHASH', 0x41: 'COINBASE', 0x42: 'TIMESTAMP', 0x43: 'NUMBER',
  0x44: 'DIFFICULTY', 0x45: 'GASLIMIT', 0x46: 'CHAINID', 0x47: 'SELFBALANCE',
  0x48: 'BASEFEE',
  0x50: 'POP', 0x51: 'MLOAD', 0x52: 'MSTORE', 0x53: 'MSTORE8',
  0x54: 'SLOAD', 0x55: 'SSTORE', 0x56: 'JUMP', 0x57: 'JUMPI',
  0x58: 'PC', 0x59: 'MSIZE', 0x5a: 'GAS', 0x5b: 'JUMPDEST',
  0xa0: 'LOG0', 0xa1: 'LOG1', 0xa2: 'LOG2', 0xa3: 'LOG3', 0xa4: 'LOG4',
  0xf0: 'CREATE', 0xf1: 'CALL', 0xf2: 'CALLCODE', 0xf3: 'RETURN',
  0xf4: 'DELEGATECALL', 0xf5: 'CREATE2', 0xfa: 'STATICCALL',
  0xfd: 'REVERT', 0xfe: 'INVALID', 0xff: 'SELFDESTRUCT',
}

// Basic EVM bytecode disassembler
function disassemble(code: string): string {
  if (!code || !code.startsWith('0x')) return code
  const hex = code.slice(2)
  const lines: string[] = []
  let pc = 0
  const maxOps = 500

  while (pc < hex.length / 2 && lines.length < maxOps) {
    const byte = parseInt(hex.slice(pc * 2, pc * 2 + 2), 16)
    const offset = pc.toString(16).padStart(4, '0')

    // PUSH1-PUSH32
    if (byte >= 0x60 && byte <= 0x7f) {
      const pushSize = byte - 0x5f
      const dataStart = (pc + 1) * 2
      const dataEnd = dataStart + pushSize * 2
      const data = hex.slice(dataStart, dataEnd) || '??'
      lines.push(`${offset}: PUSH${pushSize} 0x${data}`)
      pc += 1 + pushSize
    }
    // DUP1-DUP16
    else if (byte >= 0x80 && byte <= 0x8f) {
      lines.push(`${offset}: DUP${byte - 0x7f}`)
      pc++
    }
    // SWAP1-SWAP16
    else if (byte >= 0x90 && byte <= 0x9f) {
      lines.push(`${offset}: SWAP${byte - 0x8f}`)
      pc++
    }
    else {
      const name = OPCODES[byte] ?? `UNKNOWN(0x${byte.toString(16)})`
      lines.push(`${offset}: ${name}`)
      pc++
    }
  }

  if (pc < hex.length / 2) {
    lines.push(`... (${hex.length / 2 - pc} more bytes)`)
  }

  return lines.join('\n')
}
