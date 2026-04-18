import { JsonRpcProvider } from 'ethers'

// Browser / client bundle: NEXT_PUBLIC_* only. Server: COC_RPC_URL for SSR (same chain as Explorer).
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:18780'
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://127.0.0.1:18781'

export const SERVER_RPC_URL = process.env.COC_RPC_URL || RPC_URL

/** Server-side JSON-RPC uses COC_RPC_URL; client uses NEXT_PUBLIC_RPC_URL (falls back when COC is unset). */
export function getEffectiveRpcUrl(): string {
  return typeof window === 'undefined' ? SERVER_RPC_URL : RPC_URL
}

export const provider = new JsonRpcProvider(SERVER_RPC_URL, {
  chainId: 18780,
  name: 'ChainOfClaw',
})

export function formatHash(hash: string, start = 6, end = 4): string {
  if (!hash || hash.length < start + end) return hash
  return `${hash.slice(0, start + 2)}...${hash.slice(-end)}`
}

export function formatAddress(address: string): string {
  return formatHash(address, 6, 4)
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000)
  const now = Date.now()
  const diff = now - date.getTime()

  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`

  return date.toLocaleString('zh-CN')
}

export function formatValue(value: bigint | string | number, decimals = 18): string {
  const val = typeof value === 'bigint' ? value : BigInt(value)
  const divisor = BigInt(10 ** decimals)
  const quotient = val / divisor
  const remainder = val % divisor

  if (remainder === 0n) return quotient.toString()

  const remainderStr = remainder.toString().padStart(decimals, '0')
  const trimmed = remainderStr.replace(/0+$/, '')
  return `${quotient}.${trimmed}`
}
