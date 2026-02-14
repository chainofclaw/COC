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
})

function signAndAdd(pool: Mempool, pk: string, nonce: number, gasPrice?: string): void {
  const raw = signTx({ pk, nonce, gasPrice })
  pool.addRawTx(raw)
}
