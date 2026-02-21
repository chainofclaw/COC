/**
 * EVM data decoder utilities for the block explorer.
 * Decodes common method signatures and ERC-20 Transfer events.
 */

// Well-known 4-byte method selectors
const METHOD_SIGS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0xdd62ed3e': 'allowance(address,address)',
  '0x18160ddd': 'totalSupply()',
  '0x313ce567': 'decimals()',
  '0x06fdde03': 'name()',
  '0x95d89b41': 'symbol()',
  '0x40c10f19': 'mint(address,uint256)',
  '0x42966c68': 'burn(uint256)',
  '0xa457c2d7': 'decreaseAllowance(address,uint256)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  '0x8da5cb5b': 'owner()',
  '0x5c975abb': 'paused()',
  '0x8456cb59': 'pause()',
  '0x3f4ba83a': 'unpause()',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0xd0e30db0': 'deposit()',
  '0x150b7a02': 'onERC721Received(address,address,uint256,bytes)',
  '0x6352211e': 'ownerOf(uint256)',
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
}

// ERC-20 Transfer event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// ERC-20 Approval event topic
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'

export interface DecodedMethod {
  selector: string
  name: string
  params?: string[]
}

export interface DecodedTransfer {
  type: 'ERC20-Transfer' | 'ERC20-Approval'
  from: string
  to: string
  value: string
  contractAddress: string
}

/**
 * Decode a 4-byte method selector from input data.
 */
export function decodeMethodSelector(input: string): DecodedMethod | null {
  if (!input || input.length < 10) return null
  const selector = input.slice(0, 10).toLowerCase()
  const name = METHOD_SIGS[selector]
  if (!name) return { selector, name: `Unknown (${selector})` }
  return { selector, name }
}

/**
 * Extract address from a 32-byte topic (right-aligned, zero-padded).
 */
function topicToAddress(topic: string): string {
  if (!topic || topic.length < 66) return '0x0'
  return '0x' + topic.slice(26).toLowerCase()
}

/**
 * Decode value from hex string (big-endian uint256).
 */
function hexToDecimal(hex: string): string {
  if (!hex || hex === '0x') return '0'
  try {
    const bn = BigInt(hex)
    return bn.toString()
  } catch {
    return '0'
  }
}

/**
 * Format a raw uint256 value as a human-readable token amount.
 * Assumes 18 decimals by default (ERC-20 standard).
 */
export function formatTokenAmount(rawValue: string, decimals = 18): string {
  try {
    const bn = BigInt(rawValue)
    const divisor = 10n ** BigInt(decimals)
    const whole = bn / divisor
    const remainder = bn % divisor
    if (remainder === 0n) return whole.toString()
    const fracStr = remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
    return `${whole}.${fracStr}`
  } catch {
    return rawValue
  }
}

/**
 * Try to decode ERC-20 Transfer or Approval events from log topics/data.
 */
export function decodeTransferLog(
  log: { address: string; topics: string[]; data: string },
): DecodedTransfer | null {
  if (!log.topics || log.topics.length < 3) return null

  const topic0 = log.topics[0]?.toLowerCase()

  if (topic0 === TRANSFER_TOPIC) {
    return {
      type: 'ERC20-Transfer',
      from: topicToAddress(log.topics[1] ?? '0x'),
      to: topicToAddress(log.topics[2] ?? '0x'),
      value: hexToDecimal(log.data),
      contractAddress: log.address,
    }
  }

  if (topic0 === APPROVAL_TOPIC) {
    return {
      type: 'ERC20-Approval',
      from: topicToAddress(log.topics[1] ?? '0x'),
      to: topicToAddress(log.topics[2] ?? '0x'),
      value: hexToDecimal(log.data),
      contractAddress: log.address,
    }
  }

  return null
}
