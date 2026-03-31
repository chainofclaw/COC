// Manifest builder: constructs SnapshotManifest and computes Merkle root
// Reuses the Merkle tree algorithm from COC/node/src/ipfs-merkle.ts

import { createHash } from "node:crypto"
import type { SnapshotManifest, ManifestFileEntry } from "../types.ts"

type Hex = `0x${string}`

// -----------------------------------------------------------------------
//  Merkle tree functions (mirroring COC/node/src/ipfs-merkle.ts)
// -----------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

function hashLeaf(data: Uint8Array): Hex {
  const prefixed = Buffer.concat([Buffer.from([0x00]), data])
  return `0x${sha256Hex(prefixed)}` as Hex
}

function hashPair(left: Hex, right: Hex): Hex {
  const data = Buffer.concat([
    Buffer.from([0x01]),
    hexToBytes(left),
    hexToBytes(right),
  ])
  return `0x${sha256Hex(data)}` as Hex
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

/** Encode a string field as a length-prefixed buffer (uint32 LE + data) */
function lengthPrefixed(str: string): Buffer {
  const data = Buffer.from(str, "utf-8")
  const len = Buffer.alloc(4)
  len.writeUInt32LE(data.length, 0)
  return Buffer.concat([len, data])
}

/** Compute the Merkle root of all file entries (keyed by CID) */
export function computeDataMerkleRoot(entries: Record<string, ManifestFileEntry>): string {
  const sortedPaths = Object.keys(entries).sort()
  const leaves = sortedPaths.map((path) => {
    const entry = entries[path]
    // Leaf = hash of length-prefixed (path, CID, hash) to prevent ambiguity
    const leafData = Buffer.concat([
      lengthPrefixed(path),
      lengthPrefixed(entry.cid),
      lengthPrefixed(entry.hash),
    ])
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
