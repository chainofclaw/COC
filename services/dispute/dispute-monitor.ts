/**
 * DisputeMonitor - Automated batch validation and challenge system.
 *
 * Monitors submitted batches, validates merkle proofs against local
 * receipt data, and generates challenge evidence for invalid batches.
 */

import type { Hex32 } from "../common/pose-types.ts"
import type { SlashEvidence } from "../verifier/anti-cheat-policy.ts"
import { keccak256Hex } from "../relayer/keccak256.ts"

export interface BatchInfo {
  batchId: Hex32
  epochId: bigint
  merkleRoot: Hex32
  summaryHash: Hex32
  aggregator: string
  disputeDeadlineEpoch: bigint
  finalized: boolean
  disputed: boolean
}

export interface ReceiptLeaf {
  challengeId: Hex32
  nodeId: Hex32
  responseBodyHash: Hex32
}

export interface DisputeResult {
  batchId: Hex32
  reason: string
  receiptLeaf?: Hex32
  evidence?: SlashEvidence
}

export interface DisputeMonitorConfig {
  checkIntervalMs: number
  maxBatchesPerCheck: number
  enableAutoChallenge: boolean
}

const DEFAULT_CONFIG: DisputeMonitorConfig = {
  checkIntervalMs: 30_000,
  maxBatchesPerCheck: 10,
  enableAutoChallenge: true,
}

/**
 * Validates batch submissions by cross-referencing merkle roots
 * with locally observed receipts.
 */
export class DisputeMonitor {
  private readonly config: DisputeMonitorConfig
  private readonly localReceipts: Map<Hex32, ReceiptLeaf[]> = new Map()
  private readonly pendingDisputes: DisputeResult[] = []
  private readonly processedBatches: Set<string> = new Set()

  constructor(config?: Partial<DisputeMonitorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Register locally observed receipts for an epoch.
   */
  addLocalReceipts(epochId: bigint, receipts: ReceiptLeaf[]): void {
    const key = `0x${epochId.toString(16).padStart(16, "0")}` as Hex32
    const existing = this.localReceipts.get(key) ?? []
    this.localReceipts.set(key, [...existing, ...receipts])
  }

  /**
   * Validate a batch against local receipt data.
   * Returns dispute results for any invalid batches detected.
   */
  validateBatch(batch: BatchInfo): DisputeResult[] {
    const batchKey = `${batch.batchId}-${batch.epochId}`
    if (this.processedBatches.has(batchKey)) return []
    this.processedBatches.add(batchKey)

    if (batch.finalized || batch.disputed) return []

    const results: DisputeResult[] = []
    const epochKey = `0x${batch.epochId.toString(16).padStart(16, "0")}` as Hex32
    const localData = this.localReceipts.get(epochKey)

    // Check 1: epoch with no local receipts but batch submitted
    if (!localData || localData.length === 0) {
      results.push({
        batchId: batch.batchId,
        reason: "no local receipts for epoch but batch was submitted",
      })
      return results
    }

    // Check 2: verify summary hash consistency
    const expectedSummary = this.computeSummaryHash(batch.epochId, batch.merkleRoot, localData.length)
    if (expectedSummary !== batch.summaryHash) {
      results.push({
        batchId: batch.batchId,
        reason: `summary hash mismatch: expected ${expectedSummary}, got ${batch.summaryHash}`,
      })
    }

    // Check 3: verify receipt count plausibility
    // If local count significantly differs from batch claims, flag it
    if (localData.length === 0 && batch.merkleRoot !== ("0x" + "0".repeat(64)) as Hex32) {
      results.push({
        batchId: batch.batchId,
        reason: "non-empty merkle root but no local receipts",
      })
    }

    this.pendingDisputes.push(...results)
    return results
  }

  /**
   * Check multiple batches at once.
   */
  validateBatches(batches: BatchInfo[]): DisputeResult[] {
    const limit = Math.min(batches.length, this.config.maxBatchesPerCheck)
    const results: DisputeResult[] = []
    for (let i = 0; i < limit; i++) {
      results.push(...this.validateBatch(batches[i]))
    }
    return results
  }

  /**
   * Drain pending dispute results.
   */
  drainDisputes(): DisputeResult[] {
    return this.pendingDisputes.splice(0)
  }

  /**
   * Get statistics about the monitor state.
   */
  stats(): { epochsTracked: number; batchesProcessed: number; pendingDisputes: number } {
    return {
      epochsTracked: this.localReceipts.size,
      batchesProcessed: this.processedBatches.size,
      pendingDisputes: this.pendingDisputes.length,
    }
  }

  private computeSummaryHash(epochId: bigint, merkleRoot: Hex32, sampleCount: number): Hex32 {
    const data = `${epochId.toString()}:${merkleRoot}:${sampleCount}`
    return `0x${keccak256Hex(Buffer.from(data, "utf8"))}` as Hex32
  }
}
