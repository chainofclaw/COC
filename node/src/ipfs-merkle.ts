import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { Hex } from "./ipfs-types.ts"

export function hashLeaf(data: Uint8Array): Hex {
  // Domain-separate leaf hashes from internal node hashes to prevent
  // second-preimage attacks: H(0x00 || data) vs internal H(0x01 || left || right)
  const prefixed = Buffer.concat([Buffer.from([0x00]), data])
  return `0x${keccak256Hex(prefixed)}` as Hex
}

export function buildMerkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) {
    return zeroHash()
  }
  let level = leaves.map((x) => x)
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

export function buildMerklePath(leaves: Hex[], index: number): Hex[] {
  if (leaves.length === 0) return []
  if (index < 0 || index >= leaves.length) {
    throw new Error(`merkle path index out of bounds: ${index} (leaves: ${leaves.length})`)
  }
  let idx = index
  let level = leaves.map((x) => x)
  const path: Hex[] = []
  while (level.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1] ?? left
      if (i === idx || i + 1 === idx) {
        const sibling = i === idx ? right : left
        path.push(sibling)
        idx = Math.floor(i / 2)
      }
      next.push(hashPair(left, right))
    }
    level = next
  }
  return path
}

export function hashPair(left: Hex, right: Hex): Hex {
  // Domain-separate internal node hashes from leaf hashes to prevent
  // second-preimage attacks: H(0x01 || left || right) vs leaf H(0x00 || data)
  const data = Buffer.concat([Buffer.from([0x01]), hexToBytes(left), hexToBytes(right)])
  return `0x${keccak256Hex(data)}` as Hex
}

export function hexToBytes(value: Hex): Uint8Array {
  return Buffer.from(value.slice(2), "hex")
}

export function zeroHash(): Hex {
  return `0x${"0".repeat(64)}` as Hex
}
