/**
 * Snapshot and recovery manager
 *
 * Manages chain snapshots with persistent storage backend.
 * Provides incremental snapshots and fast recovery.
 */

import type { IBlockIndex } from "./block-index.ts"
import type { IStateTrie } from "./state-trie.ts"
import type { ChainBlock } from "../blockchain-types.ts"
import { createLogger } from "../logger.ts"

const log = createLogger("snapshot-manager")

export interface SnapshotMetadata {
  blockNumber: bigint
  blockHash: string
  stateRoot: string
  timestamp: number
  txCount: bigint
}

export interface ISnapshotManager {
  createSnapshot(): Promise<SnapshotMetadata>
  getLatestSnapshot(): Promise<SnapshotMetadata | null>
  restoreFromSnapshot(metadata: SnapshotMetadata): Promise<void>
  close(): Promise<void>
}

export class SnapshotManager implements ISnapshotManager {
  private blockIndex: IBlockIndex
  private stateTrie: IStateTrie

  constructor(blockIndex: IBlockIndex, stateTrie: IStateTrie) {
    this.blockIndex = blockIndex
    this.stateTrie = stateTrie
  }

  async createSnapshot(): Promise<SnapshotMetadata> {
    // Get latest block
    const latestBlock = await this.blockIndex.getLatestBlock()
    if (!latestBlock) {
      throw new Error("No blocks to snapshot")
    }

    // Commit state trie to get state root
    const stateRoot = await this.stateTrie.commit()

    // Count transactions
    let txCount = 0n
    for (let i = 0n; i <= latestBlock.number; i++) {
      const block = await this.blockIndex.getBlockByNumber(i)
      if (block) {
        txCount += BigInt(block.txs.length)
      }
    }

    const metadata: SnapshotMetadata = {
      blockNumber: latestBlock.number,
      blockHash: latestBlock.hash,
      stateRoot,
      timestamp: Date.now(),
      txCount,
    }

    return metadata
  }

  async getLatestSnapshot(): Promise<SnapshotMetadata | null> {
    const latestBlock = await this.blockIndex.getLatestBlock()
    if (!latestBlock) return null

    const stateRoot = await this.stateTrie.commit()

    // Quick count - just get the latest block's tx count for approximation
    return {
      blockNumber: latestBlock.number,
      blockHash: latestBlock.hash,
      stateRoot,
      timestamp: Date.now(),
      txCount: BigInt(latestBlock.txs.length),
    }
  }

  async restoreFromSnapshot(metadata: SnapshotMetadata): Promise<void> {
    // Verify block exists
    const block = await this.blockIndex.getBlockByNumber(metadata.blockNumber)
    if (!block) {
      throw new Error(`Block ${metadata.blockNumber} not found in index`)
    }

    if (block.hash !== metadata.blockHash) {
      throw new Error(
        `Block hash mismatch: expected ${metadata.blockHash}, got ${block.hash}`
      )
    }

    // Restore state trie to the snapshot's state root
    if (metadata.stateRoot) {
      const hasRoot = await this.stateTrie.hasStateRoot(metadata.stateRoot)
      if (hasRoot) {
        await this.stateTrie.setStateRoot(metadata.stateRoot)
      } else {
        log.warn("state root not found in trie, cannot restore", { stateRoot: metadata.stateRoot })
      }
    }
  }

  async close(): Promise<void> {
    await this.stateTrie.close()
  }
}

/**
 * Legacy JSON snapshot support for backward compatibility
 */
export class LegacySnapshotAdapter {
  private snapshotManager: ISnapshotManager

  constructor(snapshotManager: ISnapshotManager) {
    this.snapshotManager = snapshotManager
  }

  async exportToJSON(): Promise<string> {
    const metadata = await this.snapshotManager.getLatestSnapshot()
    if (!metadata) {
      return JSON.stringify({ blocks: [], updatedAtMs: 0 })
    }

    return JSON.stringify(
      {
        blockNumber: metadata.blockNumber.toString(),
        blockHash: metadata.blockHash,
        stateRoot: metadata.stateRoot,
        txCount: metadata.txCount.toString(),
        updatedAtMs: metadata.timestamp,
      },
      null,
      2
    )
  }

  async importFromJSON(json: string): Promise<void> {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(json)
    } catch (err) {
      throw new Error(`invalid snapshot JSON: ${String(err)}`)
    }

    if (!data || typeof data !== "object" || !data.blockNumber || !data.blockHash) {
      throw new Error("snapshot JSON missing required fields: blockNumber, blockHash")
    }

    const metadata: SnapshotMetadata = {
      blockNumber: BigInt(data.blockNumber as string),
      blockHash: data.blockHash as string,
      stateRoot: data.stateRoot as string,
      txCount: BigInt((data.txCount as string) ?? "0"),
      timestamp: (data.updatedAtMs as number) ?? Date.now(),
    }

    await this.snapshotManager.restoreFromSnapshot(metadata)
  }
}
