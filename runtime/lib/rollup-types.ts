/**
 * Shared types for COC Optimistic Rollup runtime services.
 */

export type Hex = `0x${string}`

export interface OutputProposal {
  readonly l2BlockNumber: bigint
  readonly outputRoot: Hex
  readonly l2StateRoot: Hex
  readonly blockHash: Hex
  readonly proposedAtMs: number
  readonly txHash: Hex
}

export interface RollupBatch {
  readonly startBlock: bigint
  readonly endBlock: bigint
  readonly compressedData: Uint8Array
  readonly txCount: number
  readonly submittedAtMs: number
  readonly txHash?: Hex
}

export interface ForcedTxEntry {
  readonly queueIndex: bigint
  readonly l2Tx: Hex
  readonly sender: Hex
  readonly enqueuedAt: bigint
  readonly included: boolean
}

export interface RollupStatus {
  readonly lastProposedL2Block: bigint
  readonly lastFinalizedL2Block: bigint
  readonly lastBatchedL2Block: bigint
  readonly pendingForcedTxCount: number
  readonly challengeWindowSeconds: number
}

export interface L2BlockData {
  readonly number: bigint
  readonly hash: Hex
  readonly parentHash: Hex
  readonly stateRoot: Hex
  readonly timestampMs: number
  readonly txs: readonly Hex[]
}

export interface ProposerState {
  readonly lastProposedBlockNumber: bigint
  readonly lastProposedOutputRoot: Hex
  readonly lastProposedAtMs: number
}

export interface BatcherState {
  readonly lastBatchedBlock: bigint
  readonly lastBatchTxHash: Hex
  readonly lastBatchAtMs: number
  readonly totalBatches: number
  readonly totalGasUsed: bigint
}
