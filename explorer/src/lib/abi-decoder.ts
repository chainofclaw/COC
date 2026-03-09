/**
 * ABI decoder — maps 4-byte method selectors and event topics to human-readable names.
 * Built-in table of ~50 common signatures.
 */

// Common ERC-20/721/1155 and DeFi method selectors (first 4 bytes of keccak256)
const METHOD_SIGNATURES: Record<string, string> = {
  // ERC-20
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x70a08231": "balanceOf(address)",
  "0xdd62ed3e": "allowance(address,address)",
  "0x18160ddd": "totalSupply()",
  "0x313ce567": "decimals()",
  "0x06fdde03": "name()",
  "0x95d89b41": "symbol()",

  // ERC-721
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0x6352211e": "ownerOf(uint256)",
  "0xe985e9c5": "isApprovedForAll(address,address)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0x081812fc": "getApproved(uint256)",

  // ERC-1155
  "0xf242432a": "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "0x2eb2c2d6": "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",

  // Common DeFi
  "0x38ed1739": "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "0x7ff36ab5": "swapExactETHForTokens(uint256,address[],address,uint256)",
  "0x18cbafe5": "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "0xe8e33700": "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)",
  "0xf305d719": "addLiquidityETH(address,uint256,uint256,uint256,address,uint256)",
  "0xbaa2abde": "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)",
  "0x02751cec": "removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)",

  // Proxy / Access
  "0x3659cfe6": "upgradeTo(address)",
  "0x4f1ef286": "upgradeToAndCall(address,bytes)",
  "0xf2fde38b": "transferOwnership(address)",
  "0x715018a6": "renounceOwnership()",
  "0x8da5cb5b": "owner()",

  // Staking / Governance
  "0xa694fc3a": "stake(uint256)",
  "0x2e1a7d4d": "withdraw(uint256)",
  "0x3ccfd60b": "withdraw()",
  "0xe9fad8ee": "exit()",
  "0x56781388": "castVote(uint256,uint8)",

  // Minting
  "0x40c10f19": "mint(address,uint256)",
  "0x42966c68": "burn(uint256)",
  "0x1249c58b": "mint()",
  "0xa0712d68": "mint(uint256)",

  // Multicall
  "0xac9650d8": "multicall(bytes[])",
  "0x5ae401dc": "multicall(uint256,bytes[])",

  // PoSe-specific (COC)
  "0x": "fallback()",
}

// Common event topic hashes
const EVENT_TOPICS: Record<string, string> = {
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": "Transfer(address,address,uint256)",
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": "Approval(address,address,uint256)",
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31": "ApprovalForAll(address,address,bool)",
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62": "TransferSingle(address,address,address,uint256,uint256)",
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb": "TransferBatch(address,address,address,uint256[],uint256[])",
  "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0": "OwnershipTransferred(address,address)",
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822": "Swap(address,uint256,uint256,uint256,uint256,address)",
  "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1": "Sync(uint112,uint112)",
}

/**
 * Decode a 4-byte method selector from calldata.
 * Returns the method signature or null if unknown.
 */
export function decodeMethodId(data: string): string | null {
  if (!data || data.length < 10) return null
  const selector = data.slice(0, 10).toLowerCase()
  return METHOD_SIGNATURES[selector] ?? null
}

/**
 * Decode an event topic hash.
 * Returns the event signature or null if unknown.
 */
export function decodeEventTopic(topic: string): string | null {
  if (!topic) return null
  return EVENT_TOPICS[topic.toLowerCase()] ?? null
}

/**
 * Get just the method name (without parameters) from calldata.
 */
export function decodeMethodName(data: string): string | null {
  const sig = decodeMethodId(data)
  if (!sig) return null
  const parenIdx = sig.indexOf("(")
  return parenIdx >= 0 ? sig.slice(0, parenIdx) : sig
}
