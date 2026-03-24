// Manifest builder: constructs SnapshotManifest and computes Merkle root
// Reuses the Merkle tree algorithm from COC/node/src/ipfs-merkle.ts

import { createHash } from "node:crypto"
import type { SnapshotManifest, ManifestFileEntry } from "../types.ts"

type Hex = `0x${string}`

// -----------------------------------------------------------------------
//  Merkle tree functions (mirroring COC/node/src/ipfs-merkle.ts)
// -----------------------------------------------------------------------

function keccak256Hex(data: Uint8Array): string {
  // Use sha256 as keccak256 substitute when not in EVM context
  // For backup integrity, SHA-256 is sufficient
  return createHash("sha256").update(data).digest("hex")
}

function hashLeaf(data: Uint8Array): Hex {
  const prefixed = Buffer.concat([Buffer.from([0x00]), data])
  return `0x${keccak256Hex(prefixed)}` as Hex
}

function hashPair(left: Hex, right: Hex): Hex {
  const data = Buffer.concat([
    Buffer.from([0x01]),
    hexToBytes(left),
    hexToBytes(right),
  ])
  return `0x${keccak256Hex(data)}` as Hex
}

function hexToBytes(value: Hex): Uint8Array {
  return Buffer.from(value.slice(2), "hex")
}

function zeroHash(): Hex {
  return `0x${"0".repeat(64)}` as Hex
}

export function buildMerkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return zeroHash()

  let level = [...leaves]
  while (level.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1] ?? left
      next.push(hashPair(left, right))
    }
    level = next
  }
  return level[0]
}

// -----------------------------------------------------------------------
//  Manifest building
// -----------------------------------------------------------------------

/** Compute the Merkle root of all file entries (keyed by CID) */
export function computeDataMerkleRoot(entries: Record<string, ManifestFileEntry>): string {
  const sortedPaths = Object.keys(entries).sort()
  const leaves = sortedPaths.map((path) => {
    const entry = entries[path]
    // Leaf = hash of (path + CID + SHA-256 hash)
    const leafData = Buffer.from(`${path}:${entry.cid}:${entry.hash}`, "utf-8")
    return hashLeaf(leafData)
  })

  return buildMerkleRoot(leaves)
}

/** Build a complete SnapshotManifest */
export function buildManifest(
  agentId: string,
  entries: Record<string, ManifestFileEntry>,
  parentCid: string | null,
): SnapshotManifest {
  const merkleRoot = computeDataMerkleRoot(entries)

  let totalBytes = 0
  let fileCount = 0
  for (const entry of Object.values(entries)) {
    totalBytes += entry.sizeBytes
    fileCount++
  }

  return {
    version: 1,
    agentId,
    timestamp: new Date().toISOString(),
    parentCid,
    files: entries,
    merkleRoot,
    totalBytes,
    fileCount,
  }
}
