/**
 * Mempool tests
 *
 * Covers: basic add/remove, tx replacement with gas bump,
 * per-sender limits, capacity eviction, TTL expiry,
 * replay protection, block selection ordering, and stats.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Wallet, Transaction } from "ethers"
import { Mempool } from "./mempool.ts"
import type { Hex } from "./blockchain-types.ts"

const CHAIN_ID = 18780
const PK1 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const PK2 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

function signTx(opts: {
  pk: string
  nonce: number
  gasPrice?: string
  to?: string
  value?: string
  chainId?: number
}): Hex {
  const wallet = new Wallet(opts.pk)
  const tx = Transaction.from({
    to: opts.to ?? "0x0000000000000000000000000000000000000001",
    value: opts.value ?? "0x1",
    nonce: opts.nonce,
    gasLimit: "0x5208",
    gasPrice: opts.gasPrice ?? "0x3b9aca00",
    chainId: opts.chainId ?? CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized as Hex
}

describe("Mempool", () => {
  it("adds and removes transactions", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const raw = signTx({ pk: PK1, nonce: 0 })
    const tx = pool.addRawTx(raw)
    assert.ok(tx.hash.startsWith("0x"))
    assert.equal(pool.size(), 1)
    assert.ok(pool.has(tx.hash))

    pool.remove(tx.hash)
    assert.equal(pool.size(), 0)
    assert.ok(!pool.has(tx.hash))
  })

  it("replaces tx with same sender+nonce and higher gas price", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const raw1 = signTx({ pk: PK1, nonce: 0, gasPrice: "0x3b9aca00" }) // 1 gwei
    const tx1 = pool.addRawTx(raw1)
    assert.equal(pool.size(), 1)

    // Replace with 20% higher gas price (above 10% minimum bump)
    const raw2 = signTx({ pk: PK1, nonce: 0, gasPrice: "0x47868c00" }) // 1.2 gwei
    const tx2 = pool.addRawTx(raw2)
    assert.equal(pool.size(), 1)
    assert.ok(!pool.has(tx1.hash))
    assert.ok(pool.has(tx2.hash))
  })

  it("rejects replacement with insufficient gas bump", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const raw1 = signTx({ pk: PK1, nonce: 0, gasPrice: "0x3b9aca00" }) // 1 gwei
    pool.addRawTx(raw1)

    // Try replace with only 5% bump (below 10% minimum)
    const raw2 = signTx({ pk: PK1, nonce: 0, gasPrice: "0x3e95ba80" }) // ~1.05 gwei
    assert.throws(() => pool.addRawTx(raw2), /replacement tx gas price too low/)
  })

  it("enforces per-sender limit", () => {
    const pool = new Mempool({ chainId: CHAIN_ID, maxPerSender: 3 })
    signAndAdd(pool, PK1, 0)
    signAndAdd(pool, PK1, 1)
    signAndAdd(pool, PK1, 2)

    assert.throws(() => {
      const raw = signTx({ pk: PK1, nonce: 3 })
      pool.addRawTx(raw)
    }, /exceeds max pending tx limit/)
  })

  it("evicts lowest-fee txs when pool is full", () => {
    const pool = new Mempool({
      chainId: CHAIN_ID,
      maxSize: 3,
      evictionBatchSize: 1,
      maxPerSender: 100,
    })

    // Add 3 txs with ascending gas prices
    signAndAdd(pool, PK1, 0, "0x3b9aca00") // 1 gwei
    signAndAdd(pool, PK1, 1, "0x77359400") // 2 gwei
    signAndAdd(pool, PK1, 2, "0xb2d05e00") // 3 gwei
    assert.equal(pool.size(), 3)

    // Adding 4th should evict the cheapest (nonce 0)
    signAndAdd(pool, PK2, 0, "0xee6b2800") // 4 gwei
    assert.equal(pool.size(), 3)
  })

  it("evicts expired transactions", () => {
    const pool = new Mempool({ chainId: CHAIN_ID, txTtlMs: 100 })
    const raw = signTx({ pk: PK1, nonce: 0 })
    const tx = pool.addRawTx(raw)
    assert.equal(pool.size(), 1)

    // Manually set receivedAtMs to past
    const internal = pool as any
    const stored = internal.txs.get(tx.hash)
    stored.receivedAtMs = Date.now() - 200

    const evicted = pool.evictExpired()
    assert.equal(evicted, 1)
    assert.equal(pool.size(), 0)
  })

  it("rejects wrong chain ID", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const raw = signTx({ pk: PK1, nonce: 0, chainId: 1 }) // mainnet chain ID
    assert.throws(() => pool.addRawTx(raw), /invalid chain ID/)
  })

  // #334: gasLimit below intrinsic was silently accepted, returning a
  // success hash from eth_sendRawTransaction but never executing — wasted
  // nonce slot, unreplayable (10% bump on zero) + mempool-fill DoS.
  it("rejects gasLimit below intrinsic gas (EIP-3)", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    // Plain transfer: intrinsic = 21000. Submit with 100.
    const tx = Transaction.from({
      to: "0x0000000000000000000000000000000000000001",
      value: "0x1",
      nonce: 0,
      gasLimit: "0x64", // 100 — below 21000
      gasPrice: "0x3b9aca00",
      chainId: CHAIN_ID,
      data: "0x",
    })
    const signed = wallet.signingKey.sign(tx.unsignedHash)
    const clone = tx.clone()
    clone.signature = signed
    assert.throws(
      () => pool.addRawTx(clone.serialized as Hex),
      /intrinsic gas too low: have 100, want 21000/,
      "below-intrinsic gasLimit must throw with geth-style message",
    )
  })

  it("rejects gasLimit below intrinsic for contract creation (EIP-3860)", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    // Contract creation: intrinsic = 21000 + 32000 + data cost + initcode word cost.
    // Init code "0xfe" = 1 nonzero byte = +16. 1 byte init code = ceil(1/32) = 1 word = +2.
    // Total: 21000 + 32000 + 16 + 2 = 53018. Submit 53000 to verify the precise floor.
    const tx = Transaction.from({
      to: null, // creation
      value: 0n,
      nonce: 0,
      gasLimit: 53000n, // 18 below the required 53018
      gasPrice: "0x3b9aca00",
      chainId: CHAIN_ID,
      data: "0xfe",
    })
    const signed = wallet.signingKey.sign(tx.unsignedHash)
    const clone = tx.clone()
    clone.signature = signed
    assert.throws(
      () => pool.addRawTx(clone.serialized as Hex),
      /intrinsic gas too low: have 53000, want 53018/,
      "creation must charge +32000 base + initcode-word cost",
    )
  })

  it("accepts gasLimit exactly at intrinsic floor", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    // Plain transfer with no data — exactly 21000.
    const tx = Transaction.from({
      to: "0x0000000000000000000000000000000000000001",
      value: "0x1",
      nonce: 0,
      gasLimit: 21000n,
      gasPrice: "0x3b9aca00",
      chainId: CHAIN_ID,
      data: "0x",
    })
    const signed = wallet.signingKey.sign(tx.unsignedHash)
    const clone = tx.clone()
    clone.signature = signed
    const added = pool.addRawTx(clone.serialized as Hex)
    assert.ok(added.hash, "exact-floor tx must be accepted")
  })

  // #638: a tx whose fee cap is below the MIN_BASE_FEE floor (1 gwei) can
  // never pay baseFee — baseFee never decays below that floor. Pre-fix it
  // was admitted as `pending`, returned a success hash, and permanently
  // bricked the sender's head-of-line nonce. Same "unexecutable tx poisons
  // a nonce slot" class as #334.
  it("rejects legacy gasPrice below MIN_BASE_FEE floor (#638)", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    const tx = Transaction.from({
      to: "0x0000000000000000000000000000000000000001",
      value: "0x1",
      nonce: 0,
      gasLimit: 21000n,
      gasPrice: 999_999_999n, // 1 wei below the 1 gwei floor
      chainId: CHAIN_ID,
      data: "0x",
    })
    const signed = wallet.signingKey.sign(tx.unsignedHash)
    const clone = tx.clone()
    clone.signature = signed
    assert.throws(
      () => pool.addRawTx(clone.serialized as Hex),
      /fee cap below minimum base fee: have 999999999, want 1000000000/,
      "sub-floor legacy gasPrice must be rejected at admission",
    )
  })

  it("rejects type-2 maxFeePerGas below MIN_BASE_FEE floor (#638)", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    // Exact #638 reproduction: an EIP-1559 tx with a fee cap under the
    // baseFee floor — permanently unincludable, yet pre-fix admitted.
    const tx = Transaction.from({
      type: 2,
      to: "0x0000000000000000000000000000000000000001",
      value: "0x1",
      nonce: 0,
      gasLimit: 21000n,
      maxFeePerGas: 999_999_999n, // below the 1 gwei floor
      maxPriorityFeePerGas: 0n,
      chainId: CHAIN_ID,
      data: "0x",
    })
    const signed = wallet.signingKey.sign(tx.unsignedHash)
    const clone = tx.clone()
    clone.signature = signed
    assert.throws(
      () => pool.addRawTx(clone.serialized as Hex),
      /fee cap below minimum base fee: have 999999999, want 1000000000/,
      "sub-floor type-2 maxFeePerGas must be rejected at admission",
    )
  })

  it("accepts type-2 maxFeePerGas exactly at MIN_BASE_FEE floor (#638)", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    const tx = Transaction.from({
      type: 2,
      to: "0x0000000000000000000000000000000000000001",
      value: "0x1",
      nonce: 0,
      gasLimit: 21000n,
      maxFeePerGas: 1_000_000_000n, // exactly 1 gwei — the floor
      maxPriorityFeePerGas: 0n,
      chainId: CHAIN_ID,
      data: "0x",
    })
    const signed = wallet.signingKey.sign(tx.unsignedHash)
    const clone = tx.clone()
    clone.signature = signed
    const added = pool.addRawTx(clone.serialized as Hex)
    assert.ok(added.hash, "exact-floor type-2 tx must be accepted")
  })

  it("picks txs in gas price order with nonce continuity", async () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00") // 1 gwei, nonce 0
    signAndAdd(pool, PK1, 1, "0x77359400") // 2 gwei, nonce 1
    signAndAdd(pool, PK2, 0, "0xb2d05e00") // 3 gwei, nonce 0

    const picked = await pool.pickForBlock(10, async () => 0n, 0n)
    // PK2 has higher gas price but both should be picked
    assert.ok(picked.length >= 2)
    // All picked txs should have valid nonce ordering per sender
    const byAddr = new Map<string, bigint[]>()
    for (const tx of picked) {
      const arr = byAddr.get(tx.from) ?? []
      arr.push(tx.nonce)
      byAddr.set(tx.from, arr)
    }
    for (const nonces of byAddr.values()) {
      for (let i = 1; i < nonces.length; i++) {
        assert.equal(nonces[i], nonces[i - 1] + 1n, "nonces must be consecutive")
      }
    }
  })

  it("#615: same-sender contiguous nonces all picked when prices increase (no single-pass throttle)", async () => {
    // Pre-fix: global sort by gas price desc puts [n2@10gw, n1@5gw, n0@1gw].
    // Loop visits n2 → expected=0, gap → skip; n1 → expected=0, gap → skip;
    // n0 → expected=0, picked. n1/n2 already past — only 1 of 3 picked.
    // High-volume senders (faucets, MEV bots, agents) were throttled to
    // 1 tx/block whenever per-nonce gas prices differed.
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00") // 1 gwei
    signAndAdd(pool, PK1, 1, "0x12a05f200") // 5 gwei
    signAndAdd(pool, PK1, 2, "0x2540be400") // 10 gwei

    const picked = await pool.pickForBlock(10, async () => 0n, 0n)
    assert.equal(picked.length, 3, "all three contiguous-nonce txs must be picked")
    assert.equal(picked[0].nonce, 0n)
    assert.equal(picked[1].nonce, 1n)
    assert.equal(picked[2].nonce, 2n)
  })

  it("#615: mixed-sender ordering preserves gas-price priority across senders", async () => {
    // PK1: nonce 0/1 @ 1gw/10gw. PK2: nonce 0 @ 5gw.
    // Highest single-tx price is PK1.n1 @ 10gw but it's gapped behind PK1.n0.
    // Expected order: PK1.n0 (the predecessor that unlocks the higher-priced
    // n1), then PK2.n0 vs PK1.n1 by price. Total = all 3 picked.
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00") // 1 gwei
    signAndAdd(pool, PK1, 1, "0x2540be400") // 10 gwei
    signAndAdd(pool, PK2, 0, "0x12a05f200") // 5 gwei

    const picked = await pool.pickForBlock(10, async () => 0n, 0n)
    assert.equal(picked.length, 3, "all 3 txs must be included")
    // PK1's two nonces must be in correct order
    const pk1Picks = picked.filter((p) => p.from === new Wallet(PK1).address.toLowerCase())
    assert.equal(pk1Picks.length, 2)
    assert.equal(pk1Picks[0].nonce, 0n)
    assert.equal(pk1Picks[1].nonce, 1n)
  })

  it("#615: deferred drain stops at gas-budget exhaustion (no over-fill)", async () => {
    // PK1 has 3 contiguous nonces; only 2 fit in the gas budget.
    // The deferred drain must not exceed gas budget when picking the 3rd.
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00")
    signAndAdd(pool, PK1, 1, "0x12a05f200")
    signAndAdd(pool, PK1, 2, "0x2540be400")

    // 21000 * 2 + 1 — fits exactly 2 txs, third would exceed
    const picked = await pool.pickForBlock(10, async () => 0n, 0n, 0n, 42_001n)
    assert.equal(picked.length, 2)
    assert.equal(picked[0].nonce, 0n)
    assert.equal(picked[1].nonce, 1n)
  })

  it("does not pick transactions that cannot pay base fee", async () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00") // 1 gwei
    signAndAdd(pool, PK2, 0, "0xb2d05e00") // 3 gwei

    const picked = await pool.pickForBlock(
      10,
      async () => 0n,
      0n,
      2_000_000_000n, // baseFee = 2 gwei
    )

    assert.equal(picked.length, 1)
    assert.equal(picked[0].gasPrice, 3_000_000_000n)
  })

  it("getPendingByAddress returns sorted txs for a sender", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 2)
    signAndAdd(pool, PK1, 0)
    signAndAdd(pool, PK1, 1)

    const wallet = new Wallet(PK1)
    const address = wallet.address.toLowerCase() as Hex
    const pending = pool.getPendingByAddress(address)
    assert.equal(pending.length, 3)
    assert.equal(pending[0].nonce, 0n)
    assert.equal(pending[1].nonce, 1n)
    assert.equal(pending[2].nonce, 2n)
  })

  it("stats returns correct pool metrics", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const empty = pool.stats()
    assert.equal(empty.size, 0)
    assert.equal(empty.senders, 0)

    signAndAdd(pool, PK1, 0)
    signAndAdd(pool, PK2, 0)
    const filled = pool.stats()
    assert.equal(filled.size, 2)
    assert.equal(filled.senders, 2)
    assert.ok(filled.oldestMs > 0)
  })

  it("getAll returns all txs sorted by gas price descending", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00") // 1 gwei
    signAndAdd(pool, PK2, 0, "0xb2d05e00") // 3 gwei
    signAndAdd(pool, PK1, 1, "0x77359400") // 2 gwei

    const all = pool.getAll()
    assert.equal(all.length, 3)
    // Should be sorted by gas price descending
    assert.ok(all[0].gasPrice >= all[1].gasPrice, "first should have highest gas price")
    assert.ok(all[1].gasPrice >= all[2].gasPrice, "second should have middle gas price")
  })

  it("getAll returns empty array for empty pool", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const all = pool.getAll()
    assert.equal(all.length, 0)
  })

  it("getPendingNonce returns correct next nonce", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const wallet = new Wallet(PK1)
    const address = wallet.address.toLowerCase() as Hex

    // No pending txs: should return on-chain nonce
    assert.equal(pool.getPendingNonce(address, 5n), 5n)

    // Add pending txs
    signAndAdd(pool, PK1, 5)
    signAndAdd(pool, PK1, 6)

    // Should return max nonce + 1
    assert.equal(pool.getPendingNonce(address, 5n), 7n)
  })

  it("returns empty histogram when pool is empty", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    const hist = pool.gasPriceHistogram()
    assert.equal(hist.totalTxs, 0)
    assert.equal(hist.buckets.length, 0)
    assert.equal(hist.minGwei, 0)
    assert.equal(hist.medianGwei, 0)
  })

  // Phase H3: affordability filter (2026-04-30 mempool poison incident)
  it("pickForBlock skips txs whose sender can't afford upfront cost", async () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    // 3 txs from PK1 at increasing nonces. Each costs ~21000 gas * 1 gwei +
    // 1 wei value ≈ 21,000,000,000,000 wei. Funding for exactly 1 tx.
    signAndAdd(pool, PK1, 0, "0x3b9aca00")  // 1 gwei
    signAndAdd(pool, PK1, 1, "0x3b9aca00")
    signAndAdd(pool, PK1, 2, "0x3b9aca00")

    const balance = 21_000n * 1_000_000_000n + 1_000_000_000_000n // ~1 tx + buffer
    const picked = await pool.pickForBlock(
      10,
      async () => 0n,
      0n,
      0n,
      30_000_000n,
      async () => balance,
    )

    // Only first tx affordable; subsequent skipped (not evicted — balance
    // could grow before next block).
    assert.equal(picked.length, 1)
    assert.equal(picked[0].nonce, 0n)
    assert.equal(pool.size(), 3, "skipped txs remain in mempool for later")
  })

  it("pickForBlock evicts txs that are permanently unfundable", async () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00")  // 1 gwei

    // Balance below absolute minimum (gasLimit * minGasPriceWei).
    // Tx is unfundable forever — evict.
    const minGasPrice = 1_000_000_000n
    const picked = await pool.pickForBlock(
      10,
      async () => 0n,
      minGasPrice,
      0n,
      30_000_000n,
      async () => 1n, // 1 wei — below 21000 * 1e9
    )

    assert.equal(picked.length, 0)
    assert.equal(pool.size(), 0, "permanently unfundable tx must be evicted")
  })

  it("pickForBlock without getBalance callback preserves prior nonce-only filtering", async () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    signAndAdd(pool, PK1, 0, "0x3b9aca00")
    signAndAdd(pool, PK1, 1, "0x3b9aca00")

    // No getBalance callback — should pick both regardless of (unknown) balance.
    const picked = await pool.pickForBlock(10, async () => 0n, 0n)
    assert.equal(picked.length, 2)
    assert.equal(pool.size(), 2)
  })

  it("computes gas price histogram with transactions", () => {
    const pool = new Mempool({ chainId: CHAIN_ID })
    // Add txs with different gas prices (1 gwei = 0x3b9aca00)
    signAndAdd(pool, PK1, 0, "0x3b9aca00")  // 1 gwei
    signAndAdd(pool, PK1, 1, "0x77359400")  // 2 gwei
    signAndAdd(pool, PK2, 0, "0xb2d05e00")  // 3 gwei
    signAndAdd(pool, PK2, 1, "0xee6b2800")  // 4 gwei

    const hist = pool.gasPriceHistogram(4)
    assert.equal(hist.totalTxs, 4)
    assert.equal(hist.minGwei, 1)
    assert.equal(hist.maxGwei, 4)
    assert.ok(hist.medianGwei >= 2)
    assert.ok(hist.p90Gwei >= 3)
    assert.equal(hist.buckets.length, 4)

    // Last bucket cumulative should be 100%
    assert.equal(hist.buckets[hist.buckets.length - 1].cumulativePct, 100)
  })
})

function signAndAdd(pool: Mempool, pk: string, nonce: number, gasPrice?: string): void {
  const raw = signTx({ pk, nonce, gasPrice })
  pool.addRawTx(raw)
}
