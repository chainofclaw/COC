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
import { createLogger } from "./logger.ts"
import { MIN_BASE_FEE } from "./base-fee.ts"

const log = createLogger("mempool")

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

/**
 * In-place partial selection: rearranges arr so that the first k elements are the k smallest.
 * Average O(n) via Hoare partition (quickselect). No full sort needed.
 */
function partialSelect<T>(arr: T[], k: number, compare: (a: T, b: T) => number): void {
  if (k <= 0 || k >= arr.length) return
  let lo = 0
  let hi = arr.length - 1
  while (lo < hi) {
    const pivotIdx = lo + ((hi - lo) >> 1)
    const pivot = arr[pivotIdx]
    // Move pivot to end
    ;[arr[pivotIdx], arr[hi]] = [arr[hi], arr[pivotIdx]]
    let storeIdx = lo
    for (let i = lo; i < hi; i++) {
      if (compare(arr[i], pivot) < 0) {
        ;[arr[storeIdx], arr[i]] = [arr[i], arr[storeIdx]]
        storeIdx++
      }
    }
    ;[arr[storeIdx], arr[hi]] = [arr[hi], arr[storeIdx]]
    if (storeIdx < k - 1) {
      lo = storeIdx + 1
    } else if (storeIdx > k - 1) {
      hi = storeIdx - 1
    } else {
      break
    }
  }
}

/**
 * EIP-3 / EIP-2028 / EIP-3860 intrinsic gas cost — the minimum any tx must
 * pay before the EVM even starts. Returns the floor `gasLimit` that the
 * mempool will accept; anything below is rejected as "intrinsic gas too low".
 *
 * Components (mainnet/Shanghai constants):
 *   - 21000   base (any tx)
 *   - +32000  contract creation (no `to`)
 *   - +4 per zero data byte / +16 per nonzero data byte (EIP-2028)
 *   - +2 per 32-byte init-code word (EIP-3860, contract creation only)
 */
export function computeIntrinsicGas(tx: Transaction): bigint {
  let gas = 21000n
  const isCreation = !tx.to
  if (isCreation) gas += 32000n
  const data = tx.data ?? "0x"
  const hex = data.startsWith("0x") ? data.slice(2) : data
  if (hex.length > 0) {
    let zeros = 0n
    let nonzeros = 0n
    for (let i = 0; i < hex.length; i += 2) {
      // Treat odd-length tail (shouldn't happen for valid hex) as nonzero
      const byte = hex.slice(i, i + 2)
      if (byte === "00") zeros++
      else nonzeros++
    }
    gas += zeros * 4n + nonzeros * 16n
    if (isCreation) {
      const byteLen = BigInt(hex.length / 2)
      const words = (byteLen + 31n) / 32n
      gas += words * 2n
    }
  }
  return gas
}

export class Mempool {
  private readonly txs = new Map<Hex, MempoolTx>()
  // Index: sender -> set of tx hashes for fast per-sender lookups
  private readonly bySender = new Map<Hex, Set<Hex>>()
  // Index: sender+nonce -> tx hash for replacement lookups
  private readonly byNonce = new Map<string, Hex>()
  // Tx hashes that have been observed to hang applyBlock. When a block's
  // onFinalized work times out (@ethereumjs/vm runTx hang observed on
  // testnet, unrecoverable because the inner Promise.race timer cannot
  // fire through microtask starvation), we mark every tx the block tried
  // to execute so neither gossip nor the local proposer re-includes them.
  // Bounded to avoid unbounded growth under sustained abuse.
  private readonly poisoned = new Set<Hex>()
  private readonly cfg: MempoolConfig

  constructor(config?: Partial<MempoolConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Populate the poison set from a persisted store on startup. Restarts
   * triggered by work-slot-failed → process.exit(1) would otherwise lose
   * the in-memory poison set, letting gossip re-deliver the same hung
   * tx and re-trigger the deadlock on the next block.
   */
  loadPoisonedHashes(hashes: Iterable<Hex>): void {
    for (const h of hashes) {
      this.poisoned.add(h.toLowerCase() as Hex)
    }
  }

  /** Permanently reject a tx — used after it hangs block execution. */
  poison(hash: Hex): void {
    const MAX_POISONED = 10_000
    if (this.poisoned.size >= MAX_POISONED) {
      // Drop the oldest entry (FIFO on iteration order) to keep the set bounded.
      const firstIter = this.poisoned.values().next()
      if (!firstIter.done) this.poisoned.delete(firstIter.value)
    }
    this.poisoned.add(hash.toLowerCase() as Hex)
    this.removeTx(hash)
  }

  isPoisoned(hash: Hex): boolean {
    return this.poisoned.has(hash.toLowerCase() as Hex)
  }

  /**
   * #529: structural-only validation — checks that depend solely on the
   * signed tx body, NOT on dynamic chain state (nonce, balance, hash dedup).
   * Lifted out of addRawTx so the engine layer can run it BEFORE its own
   * nonce check. Pre-fix a structurally-broken tx with a stale nonce got
   * the misleading "nonce too low" error: the caller bumped the nonce,
   * re-signed, and re-submitted only to THEN learn the tx was malformed
   * from the start. Generalizes #527 (chainId) / #613 (initcode size) to
   * the remaining structural properties. Idempotent — safe to call twice.
   */
  validateTxStructure(tx: Transaction): void {
    if (!tx.from) {
      throw new Error("invalid tx: missing sender")
    }
    // Reject blob transactions (type 3) — COC has no blob sidecar support.
    if (tx.type === 3) {
      throw new Error("blob transactions (type 3) are not supported")
    }
    const gasLimit = tx.gasLimit ?? 21000n
    // Reject gasLimit exceeding the block gas limit (prevents mempool
    // pollution with txs that can never be included in a block).
    const MAX_TX_GAS_LIMIT = 30_000_000n
    if (gasLimit > MAX_TX_GAS_LIMIT) {
      throw new Error(`gasLimit exceeds maximum: ${gasLimit} > ${MAX_TX_GAS_LIMIT}`)
    }
    // #334: reject gasLimit below the EIP-3 intrinsic gas cost. Pre-fix the
    // mempool only enforced the upper bound, so a tx with `gasLimit=100`
    // returned a success hash from eth_sendRawTransaction but could never
    // execute — wasting a nonce slot and leaving the user with a tx they
    // can't replace (without a 10% bump on already-zero gas price). Also
    // a clean mempool-fill DoS surface since these txs sit forever.
    // Geth surfaces this as -32000 "intrinsic gas too low: gas X, minimum
    // needed Y"; mirror the message so existing clients parse it.
    const intrinsicGasRequired = computeIntrinsicGas(tx)
    if (gasLimit < intrinsicGasRequired) {
      throw new Error(
        `intrinsic gas too low: have ${gasLimit}, want ${intrinsicGasRequired}`,
      )
    }
    // #638: reject a tx whose fee cap is below the MIN_BASE_FEE floor.
    // COC's baseFee (base-fee.ts) can never decay below MIN_BASE_FEE, so a
    // tx whose maxFeePerGas (or legacy gasPrice) is under that floor can
    // NEVER pay baseFee and thus never be included in a block. Pre-fix
    // eth_sendRawTransaction still accepted it, returned a hash, and let it
    // occupy the sender's head-of-line nonce forever — permanently bricking
    // the account. Same "unexecutable tx poisons a nonce slot" class as
    // #334 (intrinsic gas); reject at admission, mirroring that fix. This
    // is deliberately the absolute floor, NOT the current baseFee: a tx
    // merely below the present baseFee may become includable once baseFee
    // decays, so only the permanent-impossibility case is rejected here.
    const feeCap = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
    if (feeCap < MIN_BASE_FEE) {
      throw new Error(
        `fee cap below minimum base fee: have ${feeCap}, want ${MIN_BASE_FEE}`,
      )
    }
  }

  addRawTx(rawTx: Hex, preDecoded?: Transaction): MempoolTx {
    const tx = preDecoded ?? Transaction.from(rawTx)
    // #529: structural validation runs first. Defense-in-depth — the engine
    // layer (chain-engine{,-persistent}.ts addRawTx) also calls
    // validateTxStructure before its nonce check, but re-insertion paths
    // (block reorg, snapshot replay) reach this method directly.
    this.validateTxStructure(tx)

    // Replay protection: validate chain ID (reject chainId=0 to prevent cross-chain replay)
    if (tx.chainId !== BigInt(this.cfg.chainId)) {
      throw new Error(`invalid chain ID: expected ${this.cfg.chainId}, got ${tx.chainId}`)
    }

    if (this.poisoned.has((tx.hash as Hex).toLowerCase() as Hex)) {
      throw new Error(`tx ${tx.hash} is poisoned (hung block execution previously)`)
    }

    const from = (tx.from as string).toLowerCase() as Hex
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
      value: tx.value ?? 0n,
      receivedAtMs: Date.now(),
    }

    // Check for replacement: same sender + nonce
    const nonceKey = `${from}:${nonce}`
    const existingHash = this.byNonce.get(nonceKey)
    if (existingHash) {
      const existing = this.txs.get(existingHash)
      if (existing) {
        // Require minimum gas price bump for replacement
        // Round UP the bump to prevent zero-bump replacement when gasPrice is small
        const bump = (existing.gasPrice * BigInt(this.cfg.minGasBump) + 99n) / 100n
        const minPrice = existing.gasPrice + bump
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
    /**
     * Phase H3: optional balance fetcher. When supplied, txs whose sender
     * cannot afford `effectiveGasPrice * gasLimit + value` at proposal
     * time are dropped from the picked set (and evicted from mempool when
     * balance is below the absolute minimum). Without this callback,
     * mempool falls back to the previous nonce-only filter.
     *
     * Surfaced by 2026-04-30 testnet incident: anvil[1] balance attrition
     * (down to ~0.000170 ETH from agent activity) caused poison txs to
     * be included in proposer's blocks; applyBlock failed with
     * "insufficient funds"; chain stalled because BFT-finalized hash X
     * (clean block) didn't match proposer's local Y (with poison tx)
     * and the proposer kept retrying its local copy.
     */
    getBalance?: (address: Hex) => Promise<bigint>,
  ): Promise<MempoolTx[]> {
    if (maxTx <= 0 || this.txs.size === 0) {
      return []
    }

    this.evictExpired()

    // EIP-1559 effective gas price: min(maxFeePerGas, baseFee + maxPriorityFeePerGas)
    // For legacy txs (maxPriorityFeePerGas === 0n), use gasPrice directly to avoid
    // the EIP-1559 formula reducing effective price to min(gasPrice, baseFee).
    const effectivePrice = (tx: MempoolTx): bigint => {
      if (tx.maxFeePerGas > 0n && tx.maxPriorityFeePerGas > 0n) {
        const dynamic = baseFeePerGas + tx.maxPriorityFeePerGas
        return tx.maxFeePerGas < dynamic ? tx.maxFeePerGas : dynamic
      }
      return tx.gasPrice
    }

    // A transaction cannot be included when its fee cap is below current base fee.
    // For legacy txs, gasPrice must cover baseFee; for EIP-1559, maxFeePerGas must.
    const canPayBaseFee = (tx: MempoolTx): boolean => {
      const feeCap = tx.maxFeePerGas > 0n ? tx.maxFeePerGas : tx.gasPrice
      return feeCap >= baseFeePerGas
    }

    const sorted = [...this.txs.values()]
      .filter((tx) => canPayBaseFee(tx) && effectivePrice(tx) >= minGasPriceWei)
      .sort((a, b) => {
        const aPrice = effectivePrice(a)
        const bPrice = effectivePrice(b)
        if (aPrice !== bPrice) return aPrice > bPrice ? -1 : 1
        if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1
        return a.receivedAtMs - b.receivedAtMs
      })

    // Pre-fetch nonces for all unique senders in parallel (instead of serial per-sender)
    const uniqueSenders = new Set<Hex>()
    for (const tx of sorted) uniqueSenders.add(tx.from)
    const expected = new Map<Hex, bigint>()
    const nonceFetches = [...uniqueSenders].map(async (sender) => {
      try {
        const nonce = await getOnchainNonce(sender)
        return { sender, nonce }
      } catch {
        return { sender, nonce: -1n }
      }
    })
    const nonceResults = await Promise.all(nonceFetches)
    for (const { sender, nonce } of nonceResults) {
      expected.set(sender, nonce)
    }

    // Phase H3: pre-fetch balances for affordability check (parallel,
    // mirrors the nonce-fetch concurrency pattern). Skipped entirely
    // when no `getBalance` callback was supplied — preserves prior
    // mempool semantics for callers that don't yet wire balance check.
    const balances = new Map<Hex, bigint>()
    if (getBalance !== undefined) {
      const balanceFetches = [...uniqueSenders].map(async (sender) => {
        try {
          return { sender, balance: await getBalance(sender) }
        } catch {
          // On error we conservatively treat balance as 0 — the tx will
          // be skipped (not evicted) so it can retry next block.
          return { sender, balance: 0n }
        }
      })
      const balanceResults = await Promise.all(balanceFetches)
      for (const { sender, balance } of balanceResults) {
        balances.set(sender, balance)
      }
    }

    const picked: MempoolTx[] = []
    let cumulativeGas = 0n
    /**
     * Per-sender running spend across the picked set. When the same
     * sender has multiple pickable txs, each consumes some of their
     * balance. We track cumulative spend so the 2nd/3rd tx isn't
     * picked if the 1st already drained the wallet.
     */
    const cumulativeSpend = new Map<Hex, bigint>()
    /**
     * #615: per-sender deferred queue for txs whose nonce is ahead of
     * the sender's current expected nonce at visit time. Without this,
     * the single-pass loop wastes contiguous-nonce txs from the same
     * sender whenever the global gas-price sort visits them before
     * their predecessor.
     *
     * Repro before fix: PK1 submits nonce 0 @ 1 gwei + nonce 1 @ 5 gwei
     * + nonce 2 @ 10 gwei. Sort puts [n2, n1, n0]. Loop visits n2 → gap
     * (skip), n1 → gap (skip), n0 → pick. n1/n2 already passed → only
     * 1 of 3 picked. High-volume senders (agents, MEV bots, faucets) were
     * effectively throttled to 1 tx/block whenever their per-nonce gas
     * prices differed.
     *
     * Fix: when a tx is skipped due to gap, queue it sorted by nonce
     * under its sender. After each successful pick, drain the sender's
     * deferred queue while the head's nonce matches the freshly-advanced
     * expected nonce. Each tx is visited at most twice → O(N log N).
     */
    const deferred = new Map<Hex, MempoolTx[]>()

    // #589: per-reason rejection tally. When a proposer builds an empty
    // block from a non-empty mempool, this breakdown (logged below) is the
    // first thing needed to root-cause the stall — without it the only
    // signal is "txs=0" with no indication of which filter ate them.
    const diag = {
      nonceUnknown: 0,        // getOnchainNonce failed → expected = -1n
      staleNonceEvicted: 0,   // tx.nonce < on-chain nonce
      unaffordable: 0,        // Phase H3 balance check
      gasOrCountBudget: 0,    // block tx-count / gas limit reached
      deferredGap: 0,         // tx.nonce ahead of expected (queued)
    }

    const tryPickOne = (tx: MempoolTx): "picked" | "deferred" | "rejected" => {
      if (picked.length >= maxTx) { diag.gasOrCountBudget++; return "rejected" }
      if (cumulativeGas + tx.gasLimit > blockGasLimit) { diag.gasOrCountBudget++; return "rejected" }
      const next = expected.get(tx.from)
      if (next === undefined || next === -1n) { diag.nonceUnknown++; return "rejected" }
      // Evict transactions whose nonce is already confirmed on-chain
      if (tx.nonce < next) {
        this.removeTx(tx.hash)
        diag.staleNonceEvicted++
        return "rejected"
      }
      if (tx.nonce !== next) { diag.deferredGap++; return "deferred" }

      // Phase H3: affordability check
      if (getBalance !== undefined) {
        const balance = balances.get(tx.from) ?? 0n
        const upfrontCost = effectivePrice(tx) * tx.gasLimit + tx.value
        const alreadySpent = cumulativeSpend.get(tx.from) ?? 0n
        if (alreadySpent + upfrontCost > balance) {
          diag.unaffordable++
          // Cannot afford this tx given balance + earlier picks from
          // this sender. Don't pick. Don't evict either — balance might
          // grow before next block (e.g. inbound transfer), letting
          // this tx in then. Conservative: only evict when balance is
          // BELOW even the cheapest possible cost (i.e. at minGasPrice
          // with empty value). That's a permanently-unfundable tx.
          const absoluteMin = minGasPriceWei * tx.gasLimit
          if (balance < absoluteMin) {
            // Permanently unfundable: evict so it stops blocking the
            // sender's nonce queue indefinitely.
            this.removeTx(tx.hash)
          }
          return "rejected"
        }
        cumulativeSpend.set(tx.from, alreadySpent + upfrontCost)
      }

      picked.push(tx)
      cumulativeGas += tx.gasLimit
      expected.set(tx.from, next + 1n)
      return "picked"
    }

    const enqueueDeferred = (tx: MempoolTx): void => {
      let q = deferred.get(tx.from)
      if (!q) {
        q = []
        deferred.set(tx.from, q)
      }
      // Insert sorted by nonce ascending. Small per-sender queues in
      // practice (a few txs); linear insertion is fine.
      let i = 0
      while (i < q.length && q[i].nonce < tx.nonce) i++
      q.splice(i, 0, tx)
    }

    const drainDeferred = (sender: Hex): void => {
      const q = deferred.get(sender)
      if (!q) return
      while (q.length > 0) {
        const exp = expected.get(sender)
        if (exp === undefined || q[0].nonce !== exp) break
        const head = q.shift()!
        const r = tryPickOne(head)
        // If the eligible head was rejected (gas budget exhausted,
        // affordability), stop draining — subsequent (higher-nonce)
        // txs from this sender are now stuck behind a non-pickable
        // head and won't become eligible this block.
        if (r !== "picked") break
      }
    }

    for (const tx of sorted) {
      const result = tryPickOne(tx)
      if (result === "deferred") enqueueDeferred(tx)
      else if (result === "picked") drainDeferred(tx.from)
    }

    // #589: a proposer that builds an empty block while the mempool holds
    // pending txs is the exact stall symptom (50-tx burst → 13 empty
    // proposals across 5 validators). Log the per-reason breakdown so the
    // next occurrence is root-causable from logs alone rather than needing
    // a live cluster repro. Only fires on the empty-pick-from-non-empty
    // case, so it's silent on the normal path (no log spam).
    if (picked.length === 0 && this.txs.size > 0) {
      log.warn("pickForBlock produced an empty block from a non-empty mempool", {
        mempoolSize: this.txs.size,
        feeEligible: sorted.length,
        feeFiltered: this.txs.size - sorted.length,
        baseFeePerGas: baseFeePerGas.toString(),
        minGasPriceWei: minGasPriceWei.toString(),
        ...diag,
        stuckSenders: deferred.size,
      })
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
    // Use partial selection (O(n)) instead of full sort (O(n log n)) to find k cheapest txs.
    // For a pool of 4096 txs with batch=16, this avoids ~49K comparisons from full sort.
    const all = [...this.txs.values()]
    const count = Math.min(this.cfg.evictionBatchSize, all.length)
    if (count === 0) return

    // Partial quickselect: partition around k-th element, then take first k
    const compare = (a: MempoolTx, b: MempoolTx): number => {
      if (a.gasPrice !== b.gasPrice) return a.gasPrice < b.gasPrice ? -1 : 1
      return a.receivedAtMs - b.receivedAtMs
    }
    partialSelect(all, count, compare)
    for (let i = 0; i < count; i++) {
      this.removeTx(all[i].hash)
    }
  }
}
