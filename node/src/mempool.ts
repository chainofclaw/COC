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

    // Replay protection: validate chain ID (reject chainId=0 to prevent cross-chain replay)
    if (tx.chainId !== BigInt(this.cfg.chainId)) {
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
    baseFeePerGas: bigint = 1000000000n, // default 1 gwei
    blockGasLimit: bigint = 30_000_000n,
  ): Promise<MempoolTx[]> {
    if (maxTx <= 0 || this.txs.size === 0) {
      return []
    }

    this.evictExpired()

    // EIP-1559 effective gas price: min(maxFeePerGas, baseFee + maxPriorityFeePerGas)
    // For legacy txs (no maxFeePerGas), gasPrice is used directly
    const effectivePrice = (tx: MempoolTx): bigint => {
      if (tx.maxFeePerGas > 0n) {
        const dynamic = baseFeePerGas + tx.maxPriorityFeePerGas
        return tx.maxFeePerGas < dynamic ? tx.maxFeePerGas : dynamic
      }
      return tx.gasPrice
    }

    // A transaction cannot be included when its max fee cap is below current base fee.
    const canPayBaseFee = (tx: MempoolTx): boolean => tx.maxFeePerGas >= baseFeePerGas

    const sorted = [...this.txs.values()]
      .filter((tx) => canPayBaseFee(tx) && effectivePrice(tx) >= minGasPriceWei)
      .sort((a, b) => {
        const aPrice = effectivePrice(a)
        const bPrice = effectivePrice(b)
        if (aPrice !== bPrice) return aPrice > bPrice ? -1 : 1
        if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1
        return a.receivedAtMs - b.receivedAtMs
      })

    const picked: MempoolTx[] = []
    const expected = new Map<Hex, bigint>()
    let cumulativeGas = 0n

    for (const tx of sorted) {
      if (picked.length >= maxTx) break
      if (cumulativeGas + tx.gasLimit > blockGasLimit) continue
      let next = expected.get(tx.from)
      if (next === undefined) {
        try {
          next = await getOnchainNonce(tx.from)
        } catch {
          expected.set(tx.from, -1n)
          continue
        }
      }
      if (next === -1n) continue // sender nonce lookup failed
      if (tx.nonce !== next) {
        expected.set(tx.from, next)
        continue
      }
      picked.push(tx)
      cumulativeGas += tx.gasLimit
      expected.set(tx.from, next + 1n)
    }

    return picked
  }

  /**
   * Get the next available nonce for a sender (on-chain nonce + pending count)
   */
  getPendingNonce(from: Hex, onchainNonce: bigint): bigint {
    const normalized = from.toLowerCase() as Hex
    const senderTxs = this.bySender.get(normalized)
    if (!senderTxs || senderTxs.size === 0) return onchainNonce

    // Collect all nonces and find highest contiguous from onchainNonce
    const nonces = new Set<bigint>()
    for (const hash of senderTxs) {
      const tx = this.txs.get(hash)
      if (tx) nonces.add(tx.nonce)
    }
    let next = onchainNonce
    while (nonces.has(next)) {
      next++
    }
    return next
  }

  /**
   * Get all pending transactions in the pool, sorted by gasPrice desc.
   * Note: uses legacy gasPrice (not EIP-1559 effective price) since baseFee
   * context is unavailable here. pickForBlock() uses full effective pricing.
   */
  getAll(): MempoolTx[] {
    return [...this.txs.values()].sort((a, b) => {
      if (a.gasPrice !== b.gasPrice) return a.gasPrice > b.gasPrice ? -1 : 1
      return a.receivedAtMs - b.receivedAtMs
    })
  }

  /**
   * Gas price histogram: bucket pending txs by gasPrice ranges.
   * Uses legacy gasPrice (not EIP-1559 effective price) for display purposes.
   * Returns sorted buckets with count and cumulative percentage.
   */
  gasPriceHistogram(bucketCount = 10): {
    buckets: Array<{ minGwei: number; maxGwei: number; count: number; cumulativePct: number }>
    totalTxs: number
    minGwei: number
    maxGwei: number
    medianGwei: number
    p75Gwei: number
    p90Gwei: number
  } {
    const prices: number[] = []
    for (const tx of this.txs.values()) {
      prices.push(Number(tx.gasPrice / 1_000_000_000n)) // wei → gwei
    }

    if (prices.length === 0) {
      return { buckets: [], totalTxs: 0, minGwei: 0, maxGwei: 0, medianGwei: 0, p75Gwei: 0, p90Gwei: 0 }
    }

    prices.sort((a, b) => a - b)
    const min = prices[0]
    const max = prices[prices.length - 1]
    const range = max - min || 1
    const step = range / bucketCount

    // Single-pass bucket assignment: O(n) instead of O(n*buckets)
    const counts = new Array<number>(bucketCount).fill(0)
    for (const p of prices) {
      let idx = Math.floor((p - min) / step)
      if (idx >= bucketCount) idx = bucketCount - 1
      counts[idx]++
    }

    const buckets: Array<{ minGwei: number; maxGwei: number; count: number; cumulativePct: number }> = []
    let cumulative = 0
    for (let i = 0; i < bucketCount; i++) {
      const lo = min + step * i
      const hi = i === bucketCount - 1 ? max : min + step * (i + 1)
      cumulative += counts[i]
      buckets.push({
        minGwei: Math.round(lo * 100) / 100,
        maxGwei: Math.round(hi * 100) / 100,
        count: counts[i],
        cumulativePct: Math.round((cumulative / prices.length) * 10000) / 100,
      })
    }

    const percentile = (pct: number) => prices[Math.min(Math.floor(prices.length * pct), prices.length - 1)]

    return {
      buckets,
      totalTxs: prices.length,
      minGwei: min,
      maxGwei: max,
      medianGwei: percentile(0.5),
      p75Gwei: percentile(0.75),
      p90Gwei: percentile(0.9),
    }
  }

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
