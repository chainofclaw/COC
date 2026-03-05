// PoSe v2 batch aggregator.
// Same Merkle tree construction as v1 but with v2 evidence leaf encoding
// and reward root computation.

import { keccak256Hex } from "../relayer/keccak256.ts"
import { buildMerkleRoot, buildMerkleProof } from "../common/merkle.ts"
import type { Hex32 } from "../common/pose-types.ts"
import type { VerifiedReceiptV2, EvidenceLeafV2 } from "../common/pose-types-v2.ts"
import type { SampleProof } from "./batch-aggregator.ts"

export interface ReceiptBatchV2 {
  epochId: bigint
  merkleRoot: Hex32
  summaryHash: Hex32
  leafHashes: Hex32[]
  sampleProofs: SampleProof[]
  witnessBitmap: number
}

export interface BatchAggregatorV2Config {
  sampleSize: number
}

// Hash an evidence leaf for Merkle inclusion:
// keccak256(abi.encodePacked(challengeId, nodeId, responseAtMs, responseBodyHash, tipHash, tipHeight, witnessBitmap))
export function hashEvidenceLeafV2(receipt: VerifiedReceiptV2): Hex32 {
  const encoded = Buffer.concat([
    hexToBuffer(receipt.challenge.challengeId),
    hexToBuffer(receipt.receipt.nodeId),
    u64Buffer(receipt.receipt.responseAtMs),
    hexToBuffer(receipt.evidenceLeaf.tipHash),
    u64Buffer(receipt.evidenceLeaf.tipHeight),
    u32Buffer(receipt.evidenceLeaf.witnessBitmap),
  ])
  return `0x${keccak256Hex(encoded)}` as Hex32
}

export class BatchAggregatorV2 {
  private readonly config: BatchAggregatorV2Config

  constructor(config: BatchAggregatorV2Config) {
    this.config = config
  }

  buildBatch(epochId: bigint, receipts: VerifiedReceiptV2[]): ReceiptBatchV2 {
    if (receipts.length === 0) {
      throw new Error("empty receipt batch")
    }

    const leafHashes = receipts.map((r) => hashEvidenceLeafV2(r))
    const merkleRoot = buildMerkleRoot(leafHashes)
    const sampleIndexes = this.pickSampleIndexes(leafHashes.length, epochId)
    const sampleProofs: SampleProof[] = sampleIndexes.map((leafIndex) => ({
      leaf: leafHashes[leafIndex],
      leafIndex,
      merkleProof: buildMerkleProof(leafHashes, leafIndex),
    }))

    const summaryHash = this.buildSummaryHash(epochId, merkleRoot, sampleProofs)

    // OR-combine all witness bitmaps
    let combinedBitmap = 0
    for (const r of receipts) {
      combinedBitmap |= r.witnessBitmap
    }

    return {
      epochId,
      merkleRoot,
      summaryHash,
      leafHashes,
      sampleProofs,
      witnessBitmap: combinedBitmap,
    }
  }

  private buildSummaryHash(epochId: bigint, merkleRoot: Hex32, sampleProofs: SampleProof[]): Hex32 {
    const sampleCommitment = this.buildSampleCommitment(sampleProofs)
    const encoded = Buffer.concat([
      u64Buffer(epochId),
      hexToBuffer(merkleRoot),
      hexToBuffer(sampleCommitment),
      u32Buffer(sampleProofs.length),
    ])
    return `0x${keccak256Hex(encoded)}` as Hex32
  }

  private buildSampleCommitment(sampleProofs: SampleProof[]): Hex32 {
    let rolling = `0x${"0".repeat(64)}` as Hex32
    for (const proof of sampleProofs) {
      const encoded = Buffer.concat([
        hexToBuffer(rolling),
        u32Buffer(proof.leafIndex),
        hexToBuffer(proof.leaf),
      ])
      rolling = `0x${keccak256Hex(encoded)}` as Hex32
    }
    return rolling
  }

  private pickSampleIndexes(leafCount: number, epochId: bigint): number[] {
    const max = Math.min(this.config.sampleSize, leafCount)
    const selected = new Set<number>()

    let cursor = 0
    while (selected.size < max) {
      const seed = Buffer.concat([
        Buffer.from(epochId.toString(16).padStart(16, "0"), "hex"),
        Buffer.from(cursor.toString(16).padStart(8, "0"), "hex"),
      ])
      const digest = keccak256Hex(seed)
      const idx = Number(BigInt(`0x${digest}`) % BigInt(leafCount))
      selected.add(idx)
      cursor += 1
    }

    return [...selected].sort((a, b) => a - b)
  }
}

function hexToBuffer(hex: Hex32): Buffer {
  return Buffer.from(hex.slice(2), "hex")
}

function u64Buffer(value: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(value)
  return b
}

function u32Buffer(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
