import { JsonRpcProvider } from 'ethers'

// COC node RPC endpoints
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:28780'
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://127.0.0.1:18781'

// 创建 ethers.js Provider
export const provider = new JsonRpcProvider(RPC_URL, {
  chainId: 18780, // COC chainId
  name: 'ChainOfClaw'
})

// 格式化工具函数
export function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function formatHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('zh-CN')
}

export function formatEther(wei: bigint): string {
  const eth = Number(wei) / 1e18
  return eth.toFixed(6) + ' ETH'
}
