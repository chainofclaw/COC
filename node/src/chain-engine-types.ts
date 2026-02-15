/**
 * Chain engine interface and shared types
 *
 * Provides a common interface for both in-memory ChainEngine
 * and persistent PersistentChainEngine, allowing RPC, Consensus,
 * and P2P layers to work with either backend transparently.
 */

import type { ChainBlock, ChainSnapshot, Hex, MempoolTx } from "./blockchain-types.ts"
import type { TxReceipt } from "./evm.ts"
import type { TxWithReceipt, IndexedLog, LogFilter, AddressTxQuery } from "./storage/block-index.ts"
import type { Mempool } from "./mempool.ts"
import type { ChainEventEmitter } from "./chain-events.ts"

export interface IChainEngine {
  readonly mempool: Mempool
  readonly events: ChainEventEmitter

  // Lifecycle
  init(): Promise<void>

  // Block queries
  getTip(): ChainBlock | null | undefined | Promise<ChainBlock | null | undefined>
  getHeight(): bigint | Promise<bigint>
  getBlockByNumber(number: bigint): ChainBlock | null | Promise<ChainBlock | null>
  getBlockByHash(hash: Hex): ChainBlock | null | Promise<ChainBlock | null>
  getReceiptsByBlock(number: bigint): TxReceipt[] | Promise<TxReceipt[]>

  // Proposer
  expectedProposer(nextHeight: bigint): string

  // Transaction handling
  addRawTx(rawTx: Hex): Promise<MempoolTx>

  // Block production and application
  proposeNextBlock(): Promise<ChainBlock | null>
  applyBlock(block: ChainBlock, locallyProposed?: boolean): Promise<void>

  // Optional: persistent log and transaction queries
  getLogs?(filter: LogFilter): Promise<IndexedLog[]>
  getTransactionByHash?(hash: Hex): Promise<TxWithReceipt | null>
  getTransactionsByAddress?(address: Hex, opts?: AddressTxQuery): Promise<TxWithReceipt[]>

  // Optional: pruner stats
  getPrunerStats?(): Promise<{ latestBlock: bigint; pruningHeight: bigint; retainedBlocks: bigint }>
}

/**
 * Engines that support legacy snapshot-based sync
 */
export interface ISnapshotSyncEngine extends IChainEngine {
  makeSnapshot(): ChainSnapshot
  maybeAdoptSnapshot(snapshot: ChainSnapshot): Promise<boolean>
  getBlocks(): ChainBlock[]
}

/**
 * Engines that support block-based sync
 */
export interface IBlockSyncEngine extends IChainEngine {
  maybeAdoptSnapshot(blocks: ChainBlock[]): Promise<boolean>
  close(): Promise<void>
}

/**
 * Helper to await a possibly sync value
 */
export async function resolveValue<T>(value: T | Promise<T>): Promise<T> {
  return value
}
