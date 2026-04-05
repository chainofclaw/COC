/**
 * Batcher for COC Optimistic Rollup.
 *
 * Collects L2 blocks, compresses them via the rollup batch codec, and
 * submits the compressed data to L1 for data availability. This enables
 * fraud provers to reconstruct L2 state from L1 data alone.
 */

import { compressBatch, estimateCompressionRatio } from "./rollup-batch-codec.ts"
import type { Hex, L2BlockData, RollupBatch, BatcherState } from "./rollup-types.ts"

export interface BatcherConfig {
  readonly l2RpcUrl: string
  readonly batchInterval: number     // submit every N L2 blocks
  readonly batchTimeoutMs: number    // or after this many ms, whichever comes first
  readonly maxBatchSizeBytes: number // max compressed batch size (default 128KB)
  readonly startBlock?: bigint       // resume from this block
}

export interface L1BatchSubmitter {
  submitBatch(startBlock: bigint, endBlock: bigint, compressedData: Uint8Array): Promise<Hex>
}

export class Batcher {
  private readonly cfg: BatcherConfig
  private readonly l1: L1BatchSubmitter
  private state: BatcherState
  private pendingBlocks: L2BlockData[] = []
  private lastBatchTimeMs: number

  constructor(cfg: BatcherConfig, l1Submitter: L1BatchSubmitter, initialState?: BatcherState) {
    this.cfg = cfg
    this.l1 = l1Submitter
    this.lastBatchTimeMs = Date.now()
    this.state = initialState ?? {
      lastBatchedBlock: cfg.startBlock ?? 0n,
      lastBatchTxHash: "0x" + "0".repeat(64) as Hex,
      lastBatchAtMs: 0,
      totalBatches: 0,
      totalGasUsed: 0n,
    }
  }

  /**
   * Add a new L2 block to the pending batch.
   * Returns a submitted batch if the batch threshold is reached.
   */
  async addBlock(block: L2BlockData): Promise<RollupBatch | null> {
    // Skip blocks already batched
    if (block.number <= this.state.lastBatchedBlock) {
      return null
    }

    this.pendingBlocks.push(block)

    const blockThreshold = this.pendingBlocks.length >= this.cfg.batchInterval
    const timeThreshold = Date.now() - this.lastBatchTimeMs >= this.cfg.batchTimeoutMs

    if (blockThreshold || timeThreshold) {
      return this.flush()
    }

    return null
  }

  /**
   * Force submit the current pending blocks as a batch.
   */
  async flush(): Promise<RollupBatch | null> {
    if (this.pendingBlocks.length === 0) {
      return null
    }

    const blocks = [...this.pendingBlocks]
    const startBlock = blocks[0].number
    const endBlock = blocks[blocks.length - 1].number

    const compressedData = compressBatch(blocks)

    // Enforce max batch size
    if (compressedData.length > this.cfg.maxBatchSizeBytes) {
      // Split: submit first half, keep rest pending
      const half = Math.ceil(blocks.length / 2)
      this.pendingBlocks = blocks.slice(half)
      const firstHalf = blocks.slice(0, half)
      const smallerData = compressBatch(firstHalf)
      return this.submitBatch(firstHalf[0].number, firstHalf[firstHalf.length - 1].number, smallerData, firstHalf)
    }

    this.pendingBlocks = []
    return this.submitBatch(startBlock, endBlock, compressedData, blocks)
  }

  private async submitBatch(
    startBlock: bigint,
    endBlock: bigint,
    compressedData: Uint8Array,
    blocks: L2BlockData[],
  ): Promise<RollupBatch> {
    const txCount = blocks.reduce((sum, b) => sum + b.txs.length, 0)
    const txHash = await this.l1.submitBatch(startBlock, endBlock, compressedData)

    const batch: RollupBatch = {
      startBlock,
      endBlock,
      compressedData,
      txCount,
      submittedAtMs: Date.now(),
      txHash,
    }

    this.state = {
      lastBatchedBlock: endBlock,
      lastBatchTxHash: txHash,
      lastBatchAtMs: Date.now(),
      totalBatches: this.state.totalBatches + 1,
      totalGasUsed: this.state.totalGasUsed,
    }
    this.lastBatchTimeMs = Date.now()

    return batch
  }

  getState(): BatcherState {
    return { ...this.state }
  }

  getPendingBlockCount(): number {
    return this.pendingBlocks.length
  }

  /**
   * Estimate compression ratio for the current pending blocks.
   */
  getPendingCompressionRatio(): number {
    if (this.pendingBlocks.length === 0) return 1
    return estimateCompressionRatio(this.pendingBlocks)
  }
}
