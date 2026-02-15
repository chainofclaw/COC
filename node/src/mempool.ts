/**
 * Enhanced Mempool
 *
 * Features:
 * - EIP-1559 fee market: maxFeePerGas + maxPriorityFeePerGas support
 * - Transaction replacement: same sender+nonce with 10% gas price bump
 * - Capacity-based eviction: drops lowest-fee txs when pool is full
 * - Per-sender tx limit to prevent spam from a single address
 * - Replay protection via chain ID validation
 */

import { Transaction } from "ethers"
import type { Hex, MempoolTx } from "./blockchain-types.ts"

export interface MempoolConfig {
  maxSize: number           // max total transactions in pool
  maxPerSender: number      // max txs per sender address
  minGasBump: number        // replacement gas price bump percentage (default 10)
  evictionBatchSize: number // how many txs to evict when pool is full
  txTtlMs: number           // max age of a tx before auto-eviction
  chainId: number           // required chain ID for replay protection
}

const DEFAULT_CONFIG: MempoolConfig = {
  maxSize: 4096,
  maxPerSender: 64,
  minGasBump: 10,
  evictionBatchSize: 16,
  txTtlMs: 6 * 60 * 60 * 1000, // 6 hours
  chainId: 18780,
}

export class Mempool {
  private readonly txs = new Map<Hex, MempoolTx>()
  // Index: sender -> set of tx hashes for fast per-sender lookups
  private readonly bySender = new Map<Hex, Set<Hex>>()
  // Index: sender+nonce -> tx hash for replacement lookups
  private readonly byNonce = new Map<string, Hex>()
  private readonly cfg: MempoolConfig

  constructor(config?: Partial<MempoolConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
  }

  addRawTx(rawTx: Hex): MempoolTx {
    const tx = Transaction.from(rawTx)
    if (!tx.from) {
      throw new Error("invalid tx: missing sender")
    }

    // Replay protection: validate chain ID
    if (tx.chainId !== 0n && tx.chainId !== BigInt(this.cfg.chainId)) {
      throw new Error(`invalid chain ID: expected ${this.cfg.chainId}, got ${tx.chainId}`)
    }

    const from = tx.from.toLowerCase() as Hex
    const nonce = BigInt(tx.nonce)
    const gasPrice = tx.gasPrice ?? tx.maxFeePerGas ?? 0n
    const maxFeePerGas = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? 0n
    const gasLimit = tx.gasLimit ?? 21000n

    const item: MempoolTx = {
      hash: tx.hash as Hex,
      rawTx,
      from,
      nonce,
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      receivedAtMs: Date.now(),
    }

    // Check for replacement: same sender + nonce
    const nonceKey = `${from}:${nonce}`
    const existingHash = this.byNonce.get(nonceKey)
    if (existingHash) {
      const existing = this.txs.get(existingHash)
      if (existing) {
        // Require minimum gas price bump for replacement
        const minPrice = existing.gasPrice + (existing.gasPrice * BigInt(this.cfg.minGasBump)) / 100n
        if (item.gasPrice < minPrice) {
          throw new Error(
            `replacement tx gas price too low: need at least ${minPrice}, got ${item.gasPrice}`
          )
        }
        // Remove the old tx and replace
        this.removeTx(existingHash)
      }
    }

    // Per-sender limit check
    const senderTxs = this.bySender.get(from)
    if (senderTxs && senderTxs.size >= this.cfg.maxPerSender) {
      throw new Error(`sender ${from} exceeds max pending tx limit (${this.cfg.maxPerSender})`)
    }

    // Pool capacity check - evict if full
    if (this.txs.size >= this.cfg.maxSize) {
      this.evictLowestFee()
      if (this.txs.size >= this.cfg.maxSize) {
        throw new Error("mempool is full")
      }
    }

    // Insert tx and update indices
    this.txs.set(item.hash, item)
    this.byNonce.set(nonceKey, item.hash)

    if (!this.bySender.has(from)) {
      this.bySender.set(from, new Set())
    }
    this.bySender.get(from)!.add(item.hash)

    return item
  }

  has(hash: Hex): boolean {
    return this.txs.has(hash)
  }

  remove(hash: Hex): void {
    this.removeTx(hash)
  }

  size(): number {
    return this.txs.size
  }

  getPendingByAddress(address: Hex): MempoolTx[] {
    const normalized = address.toLowerCase() as Hex
    const hashes = this.bySender.get(normalized)
    if (!hashes) return []
    const txs: MempoolTx[] = []
    for (const hash of hashes) {
      const tx = this.txs.get(hash)
      if (tx) txs.push(tx)
    }
    return txs.sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0))
  }

  /**
   * Evict expired transactions that exceed the TTL
   */
  evictExpired(): number {
    const now = Date.now()
    const cutoff = now - this.cfg.txTtlMs
    let evicted = 0
    for (const [hash, tx] of this.txs) {
      if (tx.receivedAtMs < cutoff) {
        this.removeTx(hash)
        evicted++
      }
    }
    return evicted
  }

  async pickForBlock(
    maxTx: number,
    getOnchainNonce: (address: Hex) => Promise<bigint>,
    minGasPriceWei: bigint,
  ): Promise<MempoolTx[]> {
    if (maxTx <= 0 || this.txs.size === 0) {
      return []
    }

    // Evict expired txs before selection
    this.evictExpired()

    // EIP-1559 aware sorting: effective gas price = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)
    // For simplicity, we use gasPrice (already the effective price from ethers)
    const sorted = [...this.txs.values()]
      .filter((tx) => tx.gasPrice >= minGasPriceWei)
      .sort((a, b) => {
        // Higher gas price first
        if (a.gasPrice !== b.gasPrice) return a.gasPrice > b.gasPrice ? -1 : 1
        // Lower nonce first (for same sender ordering)
        if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1
        // Earlier arrival first
        return a.receivedAtMs - b.receivedAtMs
      })

    const picked: MempoolTx[] = []
    const expected = new Map<Hex, bigint>()

    for (const tx of sorted) {
      if (picked.length >= maxTx) break
      let next = expected.get(tx.from)
      if (next === undefined) {
        next = await getOnchainNonce(tx.from)
      }
      if (tx.nonce !== next) {
        expected.set(tx.from, next)
        continue
      }
      picked.push(tx)
      expected.set(tx.from, next + 1n)
    }

    return picked
  }

  /**
   * Get the next available nonce for a sender (on-chain nonce + pending count)
   */
  getPendingNonce(from: Hex, onchainNonce: bigint): bigint {
    const senderTxs = this.bySender.get(from)
    if (!senderTxs || senderTxs.size === 0) return onchainNonce

    let maxNonce = onchainNonce - 1n
    for (const hash of senderTxs) {
      const tx = this.txs.get(hash)
      if (tx && tx.nonce > maxNonce) maxNonce = tx.nonce
    }
    return maxNonce + 1n
  }

  /**
   * Get pool statistics
   */
  stats(): { size: number; senders: number; oldestMs: number } {
    let oldestMs = Date.now()
    for (const tx of this.txs.values()) {
      if (tx.receivedAtMs < oldestMs) oldestMs = tx.receivedAtMs
    }
    return {
      size: this.txs.size,
      senders: this.bySender.size,
      oldestMs: this.txs.size > 0 ? oldestMs : 0,
    }
  }

  private removeTx(hash: Hex): void {
    const tx = this.txs.get(hash)
    if (!tx) return

    this.txs.delete(hash)
    this.byNonce.delete(`${tx.from}:${tx.nonce}`)

    const senderSet = this.bySender.get(tx.from)
    if (senderSet) {
      senderSet.delete(hash)
      if (senderSet.size === 0) {
        this.bySender.delete(tx.from)
      }
    }
  }

  private evictLowestFee(): void {
    // Sort by gas price ascending and evict the cheapest txs
    const sorted = [...this.txs.values()].sort((a, b) => {
      if (a.gasPrice !== b.gasPrice) return a.gasPrice < b.gasPrice ? -1 : 1
      return a.receivedAtMs - b.receivedAtMs
    })

    const count = Math.min(this.cfg.evictionBatchSize, sorted.length)
    for (let i = 0; i < count; i++) {
      this.removeTx(sorted[i].hash)
    }
  }
}
