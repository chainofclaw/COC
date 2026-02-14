/**
 * Block and transaction indexing
 *
 * Provides efficient storage and retrieval of blocks and transactions
 * with multiple access patterns (by number, by hash, by address).
 */

import type { IDatabase } from "./db.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"

const BLOCK_BY_NUMBER_PREFIX = "b:"
const BLOCK_BY_HASH_PREFIX = "h:"
const TX_BY_HASH_PREFIX = "t:"
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

export interface IBlockIndex {
  putBlock(block: ChainBlock): Promise<void>
  getBlockByNumber(num: bigint): Promise<ChainBlock | null>
  getBlockByHash(hash: Hex): Promise<ChainBlock | null>
  getLatestBlock(): Promise<ChainBlock | null>
  putTransaction(txHash: Hex, tx: TxWithReceipt): Promise<void>
  getTransactionByHash(hash: Hex): Promise<TxWithReceipt | null>
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
    await this.db.put(key, txData)
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

  async close(): Promise<void> {
    // Database close is handled by parent
  }
}
