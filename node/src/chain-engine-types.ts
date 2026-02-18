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
 * Engines with governance support (ValidatorGovernance)
 */
export interface IGovernanceEngine extends IChainEngine {
  governance: {
    getActiveValidators(): Array<{
      id: string
      address: string
      stake: bigint
      votingPower: number
      active: boolean
      joinedAtEpoch: bigint
    }>
    submitProposal(
      type: string,
      targetId: string,
      proposer: string,
      opts?: { targetAddress?: string; stakeAmount?: bigint },
    ): { id: string; type: string; targetId: string; status: string }
    vote(proposalId: string, voterId: string, approve: boolean): void
    getProposal(proposalId: string): { id: string; status: string; votes: Map<string, boolean> } | null
    getProposals?(status?: string): Array<{
      id: string; type: string; targetId: string; targetAddress?: string
      stakeAmount?: bigint; proposer: string; createdAtEpoch: bigint
      expiresAtEpoch: bigint; votes: Map<string, boolean>; status: string
    }>
    getGovernanceStats?(): {
      activeValidators: number; totalStake: bigint
      pendingProposals: number; totalProposals: number; currentEpoch: bigint
    }
    getTreasuryBalance?(): bigint
    getFaction?(address: string): { address: string; faction: string; joinedAtEpoch: bigint } | null
    getFactionStats?(): Record<string, number>
  }
}

/**
 * Engines with config access
 */
export interface IConfigEngine extends IChainEngine {
  cfg: { validators: string[]; chainId: number }
}

/**
 * Engines with block index access (persistent engines)
 */
export interface IBlockIndexEngine extends IChainEngine {
  blockIndex: {
    getContracts(opts?: { limit?: number; offset?: number; reverse?: boolean }): Promise<Array<{
      address: string
      blockNumber: bigint
      txHash: string
      creator: string
      deployedAt: number
    }>>
    getContractInfo(address: Hex): Promise<{
      address: string
      blockNumber: bigint
      txHash: string
      creator: string
      deployedAt: number
    } | null>
  }
}

// Type guards
export function hasGovernance(engine: IChainEngine): engine is IGovernanceEngine {
  return "governance" in engine && !!(engine as IGovernanceEngine).governance
}

export function hasConfig(engine: IChainEngine): engine is IConfigEngine {
  return "cfg" in engine && !!(engine as IConfigEngine).cfg
}

export function hasBlockIndex(engine: IChainEngine): engine is IBlockIndexEngine {
  return "blockIndex" in engine && !!(engine as IBlockIndexEngine).blockIndex
}

/**
 * Helper to await a possibly sync value
 */
export async function resolveValue<T>(value: T | Promise<T>): Promise<T> {
  return value
}
