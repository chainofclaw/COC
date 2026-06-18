// PoSe v2 batch aggregator.
// Same Merkle tree construction as v1 but with v2 evidence leaf encoding
// and reward root computation.

import { keccak256Hex } from "../relayer/keccak256.ts"
import { buildMerkleRoot, buildMerkleProof } from "../common/merkle.ts"
import type { Hex32 } from "../common/pose-types.ts"
import type {
  VerifiedReceiptV2,
  EvidenceLeafV2,
  ReceiptBatchMetadata,
} from "../common/pose-types-v2.ts"
import { WITNESS_INDEX_UNUSED } from "../common/pose-types-v2.ts"
import type { SampleProof } from "./batch-aggregator.ts"

export interface ReceiptBatchV2 {
  epochId: bigint
  merkleRoot: Hex32
  summaryHash: Hex32
  leafHashes: Hex32[]
  sampleProofs: SampleProof[]
  witnessBitmap: number
  /**
   * Per-receipt metadata for the on-chain independent witness verification
   * path (#667). Pass to `submitBatchV2WithMetadata` together with
   * `witnessSignatures`.
   */
  metadata: ReceiptBatchMetadata
  /**
   * Witness signatures aligned with `witnessBitmap` set bits in ascending
   * order. Each entry is the signature from the witness whose
   * `metadata.witnessReceiptIndex[i]` points at the receipt this signature
   * actually attests to. Prefers v2-typehash signatures (`witnessSigV2`)
   * when available; falls back to the v1 `witnessSig` during the rollout
   * window.
   */
  witnessSignatures: `0x${string}`[]
}

export interface BatchAggregatorV2Config {
  sampleSize: number
}

// Hash an evidence leaf for Merkle inclusion:
// keccak256(
//   abi.encodePacked(
//     uint64 epoch,
//     bytes32 nodeId,
//     bytes16 nonce,
//     bytes32 tipHash,
//     uint64 tipHeight,
//     uint32 latencyMs,
//     uint8 resultCode,
//     uint32 witnessBitmap
//   )
// )
export function hashEvidenceLeafV2(receipt: VerifiedReceiptV2): Hex32 {
  const nonceBuf = hexToBufferSized(receipt.evidenceLeaf.nonce, 16)
  const encoded = Buffer.concat([
    u64Buffer(receipt.evidenceLeaf.epoch),
    hexToBuffer(receipt.evidenceLeaf.nodeId),
    nonceBuf,
    hexToBuffer(receipt.evidenceLeaf.tipHash),
    u64Buffer(receipt.evidenceLeaf.tipHeight),
    u32Buffer(receipt.evidenceLeaf.latencyMs),
    u8Buffer(receipt.evidenceLeaf.resultCode),
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

    // OR-combine all witness bitmaps (batch-level bitmap).
    let combinedBitmap = 0
    for (const r of receipts) {
      combinedBitmap |= r.witnessBitmap
    }

    // #667 — build per-receipt metadata + per-bit witness signature array.
    const metadata = this.buildMetadata(receipts, leafHashes, combinedBitmap)
    const witnessSignatures = this.collectWitnessSignatures(receipts, combinedBitmap, metadata)

    return {
      epochId,
      merkleRoot,
      summaryHash,
      leafHashes,
      sampleProofs,
      witnessBitmap: combinedBitmap,
      metadata,
      witnessSignatures,
    }
  }

  /**
   * Build the per-receipt metadata payload that `submitBatchV2WithMetadata`
   * consumes. `witnessReceiptIndex[i]` (i in 0..31) maps bit `i` of the
   * batch-level bitmap to the index of the "primary" receipt for that bit —
   * i.e. the first receipt in `receipts` whose per-receipt `witnessBitmap`
   * also has bit `i` set. Unused bits hold `WITNESS_INDEX_UNUSED`.
   */
  private buildMetadata(
    receipts: VerifiedReceiptV2[],
    leafHashes: Hex32[],
    combinedBitmap: number,
  ): ReceiptBatchMetadata {
    const witnessReceiptIndex: number[] = new Array(32).fill(WITNESS_INDEX_UNUSED)
    for (let bit = 0; bit < 32; bit++) {
      if ((combinedBitmap & (1 << bit)) === 0) continue
      // Find the first receipt whose per-receipt bitmap also has this bit.
      for (let i = 0; i < receipts.length; i++) {
        if ((receipts[i].witnessBitmap & (1 << bit)) !== 0) {
          witnessReceiptIndex[bit] = i
          break
        }
      }
    }

    return {
      challengeIds: receipts.map((r) => r.challenge.challengeId),
      nodeIds: receipts.map((r) => r.receipt.nodeId),
      responseBodyHashes: receipts.map((r) => r.receipt.responseBodyHash),
      leafHashes,
      // #746 — pull resultCode from the evidenceLeaf (set by ReceiptVerifierV2
      // when the verifier ran semantic checks). Falls back to 0 (Ok) so
      // pre-#746 receipts still produce a valid metadata payload; on-chain
      // semantics for those degenerate to "the witness signed nothing about
      // resultCode" — i.e. the v3 digest won't match and the contract will
      // fall through to v2 (which doesn't bind resultCode, gated by sunset).
      resultCodes: receipts.map((r) => r.evidenceLeaf.resultCode),
      witnessReceiptIndex,
    }
  }

  /**
   * Collect witness signatures aligned with set bits in `combinedBitmap`
   * (ascending bit order). Prefers v3 typehash (`witnessSigV3` — binds
   * resultCode, #746), then v2 (`witnessSigV2` — binds epochId, #667),
   * then v1 (`witnessSig`, legacy). Contract tries the same order on-chain.
   * Throws if a required signature is missing — the contract would
   * `revert InvalidWitnessQuorum` and the relayer would waste gas, so
   * fail loudly here instead.
   */
  private collectWitnessSignatures(
    receipts: VerifiedReceiptV2[],
    combinedBitmap: number,
    metadata: ReceiptBatchMetadata,
  ): `0x${string}`[] {
    const signatures: `0x${string}`[] = []
    for (let bit = 0; bit < 32; bit++) {
      if ((combinedBitmap & (1 << bit)) === 0) continue
      const receiptIdx = metadata.witnessReceiptIndex[bit]
      if (receiptIdx === WITNESS_INDEX_UNUSED) {
        throw new Error(`witnessReceiptIndex[${bit}] missing despite bit set`)
      }
      const receipt = receipts[receiptIdx]
      const attestation = receipt.witnesses.find((w) => w.witnessIndex === bit)
      if (!attestation) {
        throw new Error(
          `witness attestation missing for bit ${bit} on receipt ${receiptIdx} (challengeId=${receipt.challenge.challengeId})`,
        )
      }
      signatures.push(attestation.witnessSigV3 ?? attestation.witnessSigV2 ?? attestation.witnessSig)
    }
    return signatures
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

function u8Buffer(value: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeUInt8(value)
  return b
}

function hexToBufferSized(hex: `0x${string}`, size: number): Buffer {
  const raw = hex.slice(2)
  if (raw.length !== size * 2) {
    throw new Error(`expected ${size}-byte hex, got ${raw.length / 2} bytes`)
  }
  return Buffer.from(raw, "hex")
}
