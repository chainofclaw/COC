/**
 * Storage Pruner - Manages data lifecycle and cleanup.
 *
 * Provides block/tx pruning below a retention height, log cleanup,
 * and storage statistics collection.
 */

import { Transaction } from "ethers"
import type { IDatabase } from "./db.ts"
import type { IBlockIndex } from "./block-index.ts"
import { createLogger } from "../logger.ts"

const log = createLogger("pruner")
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// DB key prefixes (must match block-index.ts)
const BLOCK_BY_NUMBER_PREFIX = "b:"
const BLOCK_BY_HASH_PREFIX = "h:"
const TX_BY_HASH_PREFIX = "t:"
const LOG_BY_BLOCK_PREFIX = "l:"
const PRUNING_HEIGHT_KEY = "meta:pruning-height"

export interface PrunerConfig {
  retentionBlocks: number      // Keep this many blocks from tip
  pruneIntervalMs: number      // How often to run pruning
  batchSize: number            // Max blocks to prune per run
  enableAutoPrune: boolean     // Auto-prune on interval
}

export interface PruneResult {
  blocksRemoved: number
  txsRemoved: number
  logsRemoved: number
  newPruningHeight: bigint
  durationMs: number
}

export interface StorageStats {
  latestBlock: bigint
  pruningHeight: bigint
  retainedBlocks: bigint
}

const DEFAULT_CONFIG: PrunerConfig = {
  retentionBlocks: 10_000,
  pruneIntervalMs: 300_000, // 5 minutes
  batchSize: 100,
  enableAutoPrune: false,
}

export class StoragePruner {
  private readonly config: PrunerConfig
  private readonly db: IDatabase
  private readonly blockIndex: IBlockIndex
  private pruningHeight = 0n
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(db: IDatabase, blockIndex: IBlockIndex, config?: Partial<PrunerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.db = db
    this.blockIndex = blockIndex
  }

  /**
   * Initialize pruner, loading last pruning height from DB.
   */
  async init(): Promise<void> {
    const data = await this.db.get(PRUNING_HEIGHT_KEY)
    if (data) {
      this.pruningHeight = BigInt(decoder.decode(data))
    }
  }

  /**
   * Start automatic pruning on interval.
   */
  start(): void {
    if (this.timer || !this.config.enableAutoPrune) return
    this.timer = setInterval(() => void this.prune(), this.config.pruneIntervalMs)
  }

  /**
   * Stop automatic pruning.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Run a pruning pass. Removes blocks below (latestBlock - retentionBlocks).
   */
  async prune(): Promise<PruneResult> {
    const startTime = Date.now()
    const latest = await this.blockIndex.getLatestBlock()

    if (!latest) {
      return { blocksRemoved: 0, txsRemoved: 0, logsRemoved: 0, newPruningHeight: this.pruningHeight, durationMs: 0 }
    }

    const targetHeight = latest.number - BigInt(this.config.retentionBlocks)
    if (targetHeight <= this.pruningHeight) {
      return { blocksRemoved: 0, txsRemoved: 0, logsRemoved: 0, newPruningHeight: this.pruningHeight, durationMs: 0 }
    }

    let blocksRemoved = 0
    let txsRemoved = 0
    let logsRemoved = 0

    const endHeight = this.pruningHeight + BigInt(this.config.batchSize)
    const pruneUpto = endHeight < targetHeight ? endHeight : targetHeight

    for (let h = this.pruningHeight + 1n; h <= pruneUpto; h++) {
      const result = await this.pruneBlock(h)
      blocksRemoved += result.blockRemoved ? 1 : 0
      txsRemoved += result.txsRemoved
      logsRemoved += result.logsRemoved ? 1 : 0
    }

    this.pruningHeight = pruneUpto
    await this.db.put(PRUNING_HEIGHT_KEY, encoder.encode(this.pruningHeight.toString()))

    const durationMs = Date.now() - startTime
    if (blocksRemoved > 0) {
      log.info("pruned blocks", { blocksRemoved, txsRemoved, logsRemoved, newPruningHeight: Number(pruneUpto), durationMs })
    }

    return {
      blocksRemoved,
      txsRemoved,
      logsRemoved,
      newPruningHeight: this.pruningHeight,
      durationMs,
    }
  }

  /**
   * Get current storage statistics.
   */
  async stats(): Promise<StorageStats> {
    const latest = await this.blockIndex.getLatestBlock()
    const latestNumber = latest?.number ?? 0n

    return {
      latestBlock: latestNumber,
      pruningHeight: this.pruningHeight,
      retainedBlocks: latestNumber - this.pruningHeight,
    }
  }

  /**
   * Get current pruning height.
   */
  getPruningHeight(): bigint {
    return this.pruningHeight
  }

  private async pruneBlock(height: bigint): Promise<{ blockRemoved: boolean; txsRemoved: number; logsRemoved: boolean }> {
    const block = await this.blockIndex.getBlockByNumber(height)
    if (!block) {
      return { blockRemoved: false, txsRemoved: 0, logsRemoved: false }
    }

    const ops: Array<{ type: "del"; key: string }> = []

    // Remove block by number
    ops.push({ type: "del", key: BLOCK_BY_NUMBER_PREFIX + height.toString() })

    // Remove block by hash
    if (block.hash) {
      ops.push({ type: "del", key: BLOCK_BY_HASH_PREFIX + block.hash })
    }

    // Remove transactions by parsing raw tx to get hash
    let txCount = 0
    if (block.txs && Array.isArray(block.txs)) {
      for (const rawTx of block.txs) {
        try {
          const parsed = Transaction.from(rawTx)
          if (parsed.hash) {
            ops.push({ type: "del", key: TX_BY_HASH_PREFIX + parsed.hash.toLowerCase() })
            txCount++
          }
        } catch {
          // Skip unparseable transactions
        }
      }
    }

    // Remove logs for this block
    ops.push({ type: "del", key: LOG_BY_BLOCK_PREFIX + height.toString() })

    if (ops.length > 0) {
      await this.db.batch(ops as any)
    }

    return { blockRemoved: true, txsRemoved: txCount, logsRemoved: true }
  }
}
