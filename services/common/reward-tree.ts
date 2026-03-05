// Reward tree builder for PoSe v2 Merkle-claimable rewards.
// Computes reward leaves and builds a Merkle tree for on-chain claim verification.

import { keccak256Hex } from "../relayer/keccak256.ts"
import { buildMerkleRoot, buildMerkleProof } from "./merkle.ts"
import type { Hex32 } from "./pose-types.ts"
import type { RewardLeaf } from "./pose-types-v2.ts"
import type { EpochRewardResult } from "../verifier/scoring.ts"

// Hash a reward leaf: keccak256(abi.encodePacked(uint64 epochId, bytes32 nodeId, uint256 amount))
// = 8 + 32 + 32 = 72 bytes (amount padded to 32 bytes)
export function hashRewardLeaf(leaf: RewardLeaf): Hex32 {
  const epochBuf = Buffer.alloc(8)
  epochBuf.writeBigUInt64BE(leaf.epochId)

  const nodeIdBuf = Buffer.from(leaf.nodeId.slice(2), "hex")

  const amountBuf = Buffer.alloc(32)
  const amountHex = leaf.amount.toString(16).padStart(64, "0")
  Buffer.from(amountHex, "hex").copy(amountBuf)

  const encoded = Buffer.concat([epochBuf, nodeIdBuf, amountBuf])
  return `0x${keccak256Hex(encoded)}` as Hex32
}

// Build the reward Merkle tree from sorted leaves.
// Returns the root hash and proof for each leaf.
export function buildRewardTree(leaves: RewardLeaf[]): {
  root: Hex32
  leafHashes: Hex32[]
  proofs: Map<string, Hex32[]>
} {
  if (leaves.length === 0) {
    return {
      root: `0x${"0".repeat(64)}` as Hex32,
      leafHashes: [],
      proofs: new Map(),
    }
  }

  // Sort by nodeId for deterministic ordering
  const sorted = [...leaves].sort((a, b) =>
    a.nodeId.toLowerCase() < b.nodeId.toLowerCase() ? -1 :
    a.nodeId.toLowerCase() > b.nodeId.toLowerCase() ? 1 : 0,
  )

  const leafHashes = sorted.map((l) => hashRewardLeaf(l))
  const root = buildMerkleRoot(leafHashes)

  const proofs = new Map<string, Hex32[]>()
  for (let i = 0; i < sorted.length; i++) {
    const key = `${sorted[i].epochId}:${sorted[i].nodeId.toLowerCase()}`
    proofs.set(key, buildMerkleProof(leafHashes, i))
  }

  return { root, leafHashes, proofs }
}

// Convert scoring result to reward leaves for a given epoch.
export function scoringResultToRewardLeaves(epochId: bigint, result: EpochRewardResult): RewardLeaf[] {
  const leaves: RewardLeaf[] = []

  for (const [nodeId, amount] of Object.entries(result.rewards)) {
    if (amount > 0n) {
      leaves.push({
        epochId,
        nodeId: nodeId as Hex32,
        amount,
      })
    }
  }

  return leaves
}

// Convenience: compute reward root from scoring result.
export function buildRewardRoot(epochId: bigint, result: EpochRewardResult): {
  root: Hex32
  leaves: RewardLeaf[]
  proofs: Map<string, Hex32[]>
} {
  const leaves = scoringResultToRewardLeaves(epochId, result)
  const tree = buildRewardTree(leaves)
  return {
    root: tree.root,
    leaves,
    proofs: tree.proofs,
  }
}
