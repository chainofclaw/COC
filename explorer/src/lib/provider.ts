import { JsonRpcProvider } from 'ethers'

// Default COC R3.2 testnet (88780). 18780 was decommissioned 2026-05-12.
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || '88780')

// Public RPC endpoints (for client-side and display)
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:28780'
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://127.0.0.1:28790'

// Server-side RPC endpoint (for SSR and server operations)
// Falls back to RPC_URL so both code paths always hit the same node.
export const SERVER_RPC_URL = process.env.COC_RPC_URL || RPC_URL

// Effective RPC URL: server-side uses SERVER_RPC_URL, client-side uses RPC_URL.
export function getEffectiveRpcUrl(): string {
  return typeof window === 'undefined' ? SERVER_RPC_URL : RPC_URL
}

export const provider = new JsonRpcProvider(SERVER_RPC_URL, {
  chainId: CHAIN_ID,
  name: 'ChainOfClaw',
})

// 格式化工具函数
export function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function formatHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

export function formatEther(wei: bigint): string {
  const eth = Number(wei) / 1e18
  return eth.toFixed(6) + ' ETH'
}
