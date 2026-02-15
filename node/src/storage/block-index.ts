/**
 * Block and transaction indexing
 *
 * Provides efficient storage and retrieval of blocks and transactions
 * with multiple access patterns (by number, by hash, by address).
 */

import type { IDatabase, RangeOptions } from "./db.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"

const BLOCK_BY_NUMBER_PREFIX = "b:"
const BLOCK_BY_HASH_PREFIX = "h:"
const TX_BY_HASH_PREFIX = "t:"
const LOG_BY_BLOCK_PREFIX = "l:"
const ADDR_TX_PREFIX = "a:"
const LATEST_BLOCK_KEY = "m:latest-block"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Custom JSON serializer for BigInt
function serializeJSON(obj: any): string {
  return JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  )
}

function deserializeJSON(str: string): any {
  return JSON.parse(str)
}

export interface TransactionReceipt {
  transactionHash: Hex
  blockNumber: bigint
  blockHash: Hex
  from: Hex
  to: Hex | null
  gasUsed: bigint
  status: bigint // 1 = success, 0 = failure
  logs: Array<{
    address: Hex
    topics: Hex[]
    data: Hex
  }>
}

export interface TxWithReceipt {
  rawTx: Hex
  receipt: TransactionReceipt
}

export interface IndexedLog {
  address: Hex
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: number
  logIndex: number
}

export interface LogFilter {
  fromBlock?: bigint
  toBlock?: bigint
  address?: Hex
  topics?: Array<Hex | null>
}

export interface AddressTxQuery {
  limit?: number
  reverse?: boolean   // true = newest first (default)
}

export interface IBlockIndex {
  putBlock(block: ChainBlock): Promise<void>
  updateBlock(block: ChainBlock): Promise<void>
  getBlockByNumber(num: bigint): Promise<ChainBlock | null>
  getBlockByHash(hash: Hex): Promise<ChainBlock | null>
  getLatestBlock(): Promise<ChainBlock | null>
  putTransaction(txHash: Hex, tx: TxWithReceipt): Promise<void>
  getTransactionByHash(hash: Hex): Promise<TxWithReceipt | null>
  getTransactionsByAddress(address: Hex, opts?: AddressTxQuery): Promise<TxWithReceipt[]>
  putLogs(blockNumber: bigint, logs: IndexedLog[]): Promise<void>
  getLogs(filter: LogFilter): Promise<IndexedLog[]>
  close(): Promise<void>
}

export class BlockIndex implements IBlockIndex {
  private db: IDatabase

  constructor(db: IDatabase) {
    this.db = db
  }

  async putBlock(block: ChainBlock): Promise<void> {
    const blockData = encoder.encode(serializeJSON(block))

    await this.db.batch([
      // Store by number
      {
        type: "put",
        key: BLOCK_BY_NUMBER_PREFIX + block.number.toString(),
        value: blockData,
      },
      // Store hash -> number mapping
      {
        type: "put",
        key: BLOCK_BY_HASH_PREFIX + block.hash,
        value: encoder.encode(block.number.toString()),
      },
      // Update latest block pointer
      {
        type: "put",
        key: LATEST_BLOCK_KEY,
        value: blockData,
      },
    ])
  }

  /**
   * Update block data without changing LATEST_BLOCK_KEY.
   * Used by updateFinalityFlags to avoid resetting chain tip.
   */
  async updateBlock(block: ChainBlock): Promise<void> {
    const blockData = encoder.encode(serializeJSON(block))

    await this.db.batch([
      {
        type: "put",
        key: BLOCK_BY_NUMBER_PREFIX + block.number.toString(),
        value: blockData,
      },
      {
        type: "put",
        key: BLOCK_BY_HASH_PREFIX + block.hash,
        value: encoder.encode(block.number.toString()),
      },
    ])
  }

  async getBlockByNumber(num: bigint): Promise<ChainBlock | null> {
    const key = BLOCK_BY_NUMBER_PREFIX + num.toString()
    const data = await this.db.get(key)

    if (!data) return null

    const block = deserializeJSON(decoder.decode(data))
    // Convert number back to bigint
    block.number = BigInt(block.number)
    return block
  }

  async getBlockByHash(hash: Hex): Promise<ChainBlock | null> {
    // First get the block number from hash
    const numKey = BLOCK_BY_HASH_PREFIX + hash
    const numData = await this.db.get(numKey)

    if (!numData) return null

    const blockNum = BigInt(decoder.decode(numData))
    return this.getBlockByNumber(blockNum)
  }

  async getLatestBlock(): Promise<ChainBlock | null> {
    const data = await this.db.get(LATEST_BLOCK_KEY)

    if (!data) return null

    const block = deserializeJSON(decoder.decode(data))
    block.number = BigInt(block.number)
    return block
  }

  async putTransaction(txHash: Hex, tx: TxWithReceipt): Promise<void> {
    const key = TX_BY_HASH_PREFIX + txHash
    const txData = encoder.encode(serializeJSON(tx))
    const ops: Array<{ type: "put"; key: string; value: Uint8Array }> = [
      { type: "put", key, value: txData },
    ]

    // Build address indexes for from/to
    const blockPad = padBlockNumber(tx.receipt.blockNumber)
    const hashLower = txHash.toLowerCase()

    if (tx.receipt.from) {
      const fromKey = ADDR_TX_PREFIX + tx.receipt.from.toLowerCase() + ":" + blockPad + ":" + hashLower
      ops.push({ type: "put", key: fromKey, value: encoder.encode(txHash) })
    }
    if (tx.receipt.to) {
      const toKey = ADDR_TX_PREFIX + tx.receipt.to.toLowerCase() + ":" + blockPad + ":" + hashLower
      ops.push({ type: "put", key: toKey, value: encoder.encode(txHash) })
    }

    await this.db.batch(ops)
  }

  async getTransactionByHash(hash: Hex): Promise<TxWithReceipt | null> {
    const key = TX_BY_HASH_PREFIX + hash
    const data = await this.db.get(key)

    if (!data) return null

    const tx = deserializeJSON(decoder.decode(data))
    // Convert bigints back
    if (tx.receipt) {
      tx.receipt.blockNumber = BigInt(tx.receipt.blockNumber)
      tx.receipt.gasUsed = BigInt(tx.receipt.gasUsed)
      tx.receipt.status = BigInt(tx.receipt.status)
    }
    return tx
  }

  async getTransactionsByAddress(address: Hex, opts?: AddressTxQuery): Promise<TxWithReceipt[]> {
    const prefix = ADDR_TX_PREFIX + address.toLowerCase() + ":"
    const limit = opts?.limit ?? 50
    const reverse = opts?.reverse ?? true
    const keys = await this.db.getKeysWithPrefix(prefix, { limit, reverse })

    const results: TxWithReceipt[] = []
    for (const key of keys) {
      const data = await this.db.get(key)
      if (!data) continue
      const txHash = decoder.decode(data) as Hex
      const tx = await this.getTransactionByHash(txHash)
      if (tx) results.push(tx)
    }
    return results
  }

  async putLogs(blockNumber: bigint, logs: IndexedLog[]): Promise<void> {
    if (logs.length === 0) return
    const key = LOG_BY_BLOCK_PREFIX + blockNumber.toString()
    const data = encoder.encode(serializeJSON(logs))
    await this.db.put(key, data)
  }

  async getLogs(filter: LogFilter): Promise<IndexedLog[]> {
    const from = filter.fromBlock ?? 0n
    const to = filter.toBlock ?? (await this.getLatestBlock())?.number ?? 0n
    const results: IndexedLog[] = []

    for (let n = from; n <= to; n++) {
      const key = LOG_BY_BLOCK_PREFIX + n.toString()
      const data = await this.db.get(key)
      if (!data) continue

      const blockLogs: IndexedLog[] = deserializeJSON(decoder.decode(data))
      for (const log of blockLogs) {
        // Restore bigint fields
        log.blockNumber = BigInt(log.blockNumber)

        if (!matchLogFilter(log, filter)) continue
        results.push(log)
      }
    }

    return results
  }

  async close(): Promise<void> {
    // Database close is handled by parent
  }
}

// Zero-pad block number for lexicographic ordering (20 digits)
function padBlockNumber(n: bigint): string {
  return n.toString().padStart(20, "0")
}

function matchLogFilter(log: IndexedLog, filter: LogFilter): boolean {
  if (filter.address) {
    if (log.address.toLowerCase() !== filter.address.toLowerCase()) return false
  }
  if (filter.topics && filter.topics.length > 0) {
    for (let i = 0; i < filter.topics.length; i++) {
      const expected = filter.topics[i]
      if (!expected) continue
      const actual = log.topics[i]
      if (!actual || actual.toLowerCase() !== expected.toLowerCase()) return false
    }
  }
  return true
}
