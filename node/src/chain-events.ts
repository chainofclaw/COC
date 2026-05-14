/**
 * Chain event emitter
 *
 * Provides typed event emission for chain state changes including
 * new blocks, pending transactions, and log entries. Used by the
 * WebSocket RPC server to push real-time updates to subscribers.
 */

import { EventEmitter } from "node:events"
import type { ChainBlock, Hex, MempoolTx } from "./blockchain-types.ts"
import type { IndexedLog } from "./storage/block-index.ts"
import { buildBlockHeaderView, type ReceiptLike } from "./block-header.ts"

export interface BlockEvent {
  block: ChainBlock
  receipts: ReceiptLike[]
}

export interface PendingTxEvent {
  hash: Hex
  from: Hex
  nonce: bigint
  gasPrice: bigint
}

export interface LogEvent {
  log: IndexedLog
}

export type ChainEventType = "newBlock" | "pendingTx" | "log"

export class ChainEventEmitter {
  private emitter: EventEmitter

  constructor() {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(1000)
  }

  emitNewBlock(event: BlockEvent): void {
    this.emitter.emit("newBlock", event)
  }

  emitPendingTx(event: PendingTxEvent): void {
    this.emitter.emit("pendingTx", event)
  }

  emitLog(event: LogEvent): void {
    this.emitter.emit("log", event)
  }

  onNewBlock(handler: (event: BlockEvent) => void): void {
    this.emitter.on("newBlock", handler)
  }

  onPendingTx(handler: (event: PendingTxEvent) => void): void {
    this.emitter.on("pendingTx", handler)
  }

  onLog(handler: (event: LogEvent) => void): void {
    this.emitter.on("log", handler)
  }

  offNewBlock(handler: (event: BlockEvent) => void): void {
    this.emitter.off("newBlock", handler)
  }

  offPendingTx(handler: (event: PendingTxEvent) => void): void {
    this.emitter.off("pendingTx", handler)
  }

  offLog(handler: (event: LogEvent) => void): void {
    this.emitter.off("log", handler)
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners()
  }

  listenerCount(event: ChainEventType): number {
    return this.emitter.listenerCount(event)
  }
}

/**
 * Format a block into the eth_subscription "newHeads" format
 */
export async function formatNewHeadsNotification(event: BlockEvent): Promise<Record<string, unknown>> {
  const { block, receipts } = event
  const headerView = await buildBlockHeaderView(block, receipts)
  // #487: same-block-shape parity with rpc.ts:formatBlock. Pre-fix this
  // function returned 16 fields while eth_getBlockByNumber returned 26
  // (minus `transactions` which is correctly omitted from newHeads, per
  // spec). Missing: mixHash, size, totalDifficulty, withdrawals,
  // withdrawalsRoot, blobGasUsed, excessBlobGas, parentBeaconBlockRoot,
  // finalized. ethers/viem feature-detect Cancun support by inspecting
  // the head, so missing Cancun fields made the chain appear pre-Cancun
  // to subscription clients while query clients saw the correct fields.
  // EMPTY_TRIE_ROOT is geth/erigon's withdrawalsRoot for empty withdrawals.
  const EMPTY_TRIE_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
  const ZERO_HASH = "0x" + "0".repeat(64)
  const HEADER_OVERHEAD = 508
  let txBytesSize = 0
  for (const rawTx of block.txs) {
    txBytesSize += Math.max(0, (rawTx.length - 2)) / 2
  }
  const blockSize = HEADER_OVERHEAD + Math.floor(txBytesSize)
  return {
    number: `0x${block.number.toString(16)}`,
    hash: block.hash,
    parentHash: block.parentHash,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO_HASH,
    logsBloom: headerView.logsBloom,
    transactionsRoot: headerView.transactionsRoot,
    stateRoot: headerView.stateRoot,
    receiptsRoot: headerView.receiptsRoot,
    miner: block.proposer.startsWith("0x") ? block.proposer : "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    // #448: encode proposer as address bytes (20 bytes), not ASCII string.
    // See rpc.ts:formatBlockResponse for context. Falls back to UTF-8
    // (truncated to 32 bytes) when proposer isn't a hex address.
    extraData: /^0x[0-9a-fA-F]{40}$/.test(block.proposer)
      ? block.proposer.toLowerCase()
      : `0x${Buffer.from(block.proposer, "utf-8").toString("hex").slice(0, 64)}`,
    mixHash: ZERO_HASH,
    size: `0x${blockSize.toString(16)}`,
    gasLimit: "0x1c9c380",
    gasUsed: `0x${headerView.gasUsed.toString(16)}`,
    timestamp: `0x${Math.floor(block.timestampMs / 1000).toString(16)}`,
    baseFeePerGas: `0x${headerView.baseFeePerGas.toString(16)}`,
    withdrawals: [],
    withdrawalsRoot: EMPTY_TRIE_ROOT,
    blobGasUsed: `0x${(block.blobGasUsed ?? 0n).toString(16)}`,
    excessBlobGas: `0x${(block.excessBlobGas ?? 0n).toString(16)}`,
    parentBeaconBlockRoot: block.parentBeaconBlockRoot ?? ZERO_HASH,
    finalized: block.finalized ?? false,
  }
}

/**
 * Format a log entry into the eth_subscription "logs" format
 */
export function formatLogNotification(log: IndexedLog): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: `0x${log.blockNumber.toString(16)}`,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: `0x${log.transactionIndex.toString(16)}`,
    logIndex: `0x${log.logIndex.toString(16)}`,
    removed: false,
  }
}
