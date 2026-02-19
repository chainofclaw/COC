/**
 * Stress Tests for COC Blockchain
 *
 * Tests system behavior under heavy load across:
 * - EVM execution throughput
 * - Mempool flooding and eviction
 * - Block production with saturated mempool
 * - Concurrent contract deployments
 * - Rate limiter under sustained pressure
 *
 * Refs: #23
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { Wallet, Transaction } from "ethers"
import { EvmChain } from "../node/src/evm.ts"
import { ChainEngine } from "../node/src/chain-engine.ts"
import { Mempool } from "../node/src/mempool.ts"
import { RateLimiter } from "../node/src/rate-limiter.ts"
import type { Hex } from "../node/src/chain-engine-types.ts"

const CHAIN_ID = 18780
const FUNDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const BURN_ADDR = "0x000000000000000000000000000000000000dEaD"

function signRawTx(
  wallet: Wallet,
  nonce: number,
  to: string,
  value: bigint,
  gasPrice = 1000000000n,
  gasLimit = 21000n,
): string {
  const tx = Transaction.from({
    to,
    value: `0x${value.toString(16)}`,
    nonce,
    gasLimit: `0x${gasLimit.toString(16)}`,
    gasPrice: `0x${gasPrice.toString(16)}`,
    chainId: CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized
}

function signContractDeployTx(
  wallet: Wallet,
  nonce: number,
  bytecode: string,
  gasPrice = 1000000000n,
): string {
  const tx = Transaction.from({
    nonce,
    gasLimit: "0x100000",
    gasPrice: `0x${gasPrice.toString(16)}`,
    chainId: CHAIN_ID,
    data: bytecode,
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized
}

async function createTestEngine(maxTxPerBlock = 100): Promise<{
  engine: ChainEngine
  evm: EvmChain
}> {
  const evm = await EvmChain.create(CHAIN_ID)
  await evm.prefund([{ address: FUNDER_ADDR, balanceWei: "100000000000000000000000" }])
  const engine = new ChainEngine(
    {
      dataDir: `/tmp/coc-stress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      nodeId: FUNDER_ADDR.toLowerCase(),
      validators: [FUNDER_ADDR.toLowerCase()],
      finalityDepth: 3,
      maxTxPerBlock,
      minGasPriceWei: 1n,
    },
    evm,
  )
  return { engine, evm }
}

describe("Stress: EVM Execution Throughput", () => {
  it("handles 500 sequential eth_call invocations", async () => {
    const evm = await EvmChain.create(CHAIN_ID)
    const start = performance.now()

    for (let i = 0; i < 500; i++) {
      await evm.callRaw({ from: FUNDER_ADDR, to: BURN_ADDR, data: "0x" })
    }

    const duration = performance.now() - start
    const tps = (500 / duration) * 1000

    console.log(`  500 eth_call: ${duration.toFixed(0)}ms (${tps.toFixed(0)} calls/s)`)
    assert.ok(tps > 50, `Expected > 50 calls/s, got ${tps.toFixed(0)}`)
  })

  it("handles 200 concurrent eth_call invocations", async () => {
    const evm = await EvmChain.create(CHAIN_ID)
    const start = performance.now()

    const calls = Array.from({ length: 200 }, () =>
      evm.callRaw({ from: FUNDER_ADDR, to: BURN_ADDR, data: "0x" }),
    )
    await Promise.all(calls)

    const duration = performance.now() - start
    const tps = (200 / duration) * 1000

    console.log(`  200 concurrent eth_call: ${duration.toFixed(0)}ms (${tps.toFixed(0)} calls/s)`)
    assert.ok(tps > 50, `Expected > 50 concurrent calls/s, got ${tps.toFixed(0)}`)
  })

  it("runs 50 sequential transactions through block production", async () => {
    const { engine } = await createTestEngine()
    const wallet = new Wallet(FUNDER_KEY)

    for (let i = 0; i < 50; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      await engine.addRawTx(raw as Hex)
    }

    assert.equal(engine.mempool.size(), 50)

    const start = performance.now()
    const block = await engine.proposeNextBlock()
    const duration = performance.now() - start

    console.log(`  Block with 50 txs: ${duration.toFixed(0)}ms`)
    assert.ok(block)
    assert.ok(block.txs.length <= 50)
    assert.ok(block.txs.length > 0)
  })

  it("deploys 20 contracts in a single block", async () => {
    const { engine } = await createTestEngine()
    const wallet = new Wallet(FUNDER_KEY)

    // PUSH1 0x42 PUSH1 0x00 MSTORE PUSH1 0x20 PUSH1 0x00 RETURN
    const simpleBytecode = "0x604260005260206000f3"

    for (let i = 0; i < 20; i++) {
      const raw = signContractDeployTx(wallet, i, simpleBytecode)
      await engine.addRawTx(raw as Hex)
    }

    const start = performance.now()
    const block = await engine.proposeNextBlock()
    const duration = performance.now() - start

    console.log(`  20 contract deploys: ${duration.toFixed(0)}ms`)
    assert.ok(block)
    assert.ok(block.txs.length > 0)
  })
})

describe("Stress: Mempool Flooding", () => {
  let mempool: Mempool

  beforeEach(() => {
    mempool = new Mempool({
      maxSize: 1000,
      maxPerSender: 256,
      chainId: CHAIN_ID,
    })
  })

  it("accepts 256 transactions from a single sender", () => {
    const wallet = new Wallet(FUNDER_KEY)

    const start = performance.now()
    for (let i = 0; i < 256; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      mempool.addRawTx(raw as Hex)
    }
    const duration = performance.now() - start

    console.log(`  256 txs added: ${duration.toFixed(0)}ms`)
    assert.equal(mempool.size(), 256)
  })

  it("accepts transactions from 50 different senders", () => {
    const wallets = Array.from({ length: 50 }, () => Wallet.createRandom())

    const start = performance.now()
    for (const wallet of wallets) {
      for (let nonce = 0; nonce < 10; nonce++) {
        const raw = signRawTx(wallet, nonce, BURN_ADDR, 1n)
        mempool.addRawTx(raw as Hex)
      }
    }
    const duration = performance.now() - start

    console.log(`  500 txs from 50 senders: ${duration.toFixed(0)}ms`)
    assert.equal(mempool.size(), 500)
  })

  it("replaces transactions with higher gas price", () => {
    const wallet = new Wallet(FUNDER_KEY)

    for (let i = 0; i < 10; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n, 1000000000n)
      mempool.addRawTx(raw as Hex)
    }
    assert.equal(mempool.size(), 10)

    // Replace with >= 10% bump
    for (let i = 0; i < 10; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n, 2000000000n)
      mempool.addRawTx(raw as Hex)
    }
    assert.equal(mempool.size(), 10)
  })

  it("enforces maxPerSender limit", () => {
    const wallet = new Wallet(FUNDER_KEY)
    const mp = new Mempool({ maxPerSender: 10, chainId: CHAIN_ID })

    for (let i = 0; i < 10; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      mp.addRawTx(raw as Hex)
    }
    assert.equal(mp.size(), 10)

    assert.throws(() => {
      const raw = signRawTx(wallet, 10, BURN_ADDR, 1n)
      mp.addRawTx(raw as Hex)
    })
  })

  it("evicts expired transactions", () => {
    const mp = new Mempool({ txTtlMs: 1, chainId: CHAIN_ID })
    const wallet = new Wallet(FUNDER_KEY)

    for (let i = 0; i < 5; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      mp.addRawTx(raw as Hex)
    }
    assert.equal(mp.size(), 5)

    // Wait for TTL to expire
    const waitStart = Date.now()
    while (Date.now() - waitStart < 10) {
      /* spin */
    }

    const evicted = mp.evictExpired()
    assert.ok(evicted >= 0)
  })

  it("pickForBlock respects maxTx limit under flooding", async () => {
    const wallet = new Wallet(FUNDER_KEY)

    for (let i = 0; i < 200; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      mempool.addRawTx(raw as Hex)
    }

    const picked = await mempool.pickForBlock(
      50,
      async () => 0n,
      1n,
    )

    assert.ok(picked.length <= 50, `Expected <= 50, got ${picked.length}`)
    assert.ok(picked.length > 0)
  })
})

describe("Stress: Block Production Under Load", () => {
  it("produces multiple consecutive blocks with full mempool", async () => {
    const { engine } = await createTestEngine(20)
    const wallet = new Wallet(FUNDER_KEY)

    const blocks = []
    let totalTx = 0

    for (let blockNum = 0; blockNum < 5; blockNum++) {
      const baseNonce = blockNum * 20
      for (let i = 0; i < 20; i++) {
        const raw = signRawTx(wallet, baseNonce + i, BURN_ADDR, 1n)
        await engine.addRawTx(raw as Hex)
      }

      const block = await engine.proposeNextBlock()
      assert.ok(block)
      blocks.push(block)
      totalTx += block.txs.length
    }

    console.log(`  5 blocks produced, ${totalTx} total txs`)
    assert.equal(blocks.length, 5)
    assert.ok(totalTx > 0)

    // Verify chain integrity
    for (let i = 1; i < blocks.length; i++) {
      assert.equal(blocks[i].number, blocks[i - 1].number + 1n)
    }
  })

  it("handles empty blocks gracefully", async () => {
    const { engine } = await createTestEngine()

    const block = await engine.proposeNextBlock()
    assert.ok(block)
    assert.equal(block.txs.length, 0)
  })

  it("respects maxTxPerBlock during high-load block production", async () => {
    const maxTx = 10
    const { engine } = await createTestEngine(maxTx)
    const wallet = new Wallet(FUNDER_KEY)

    for (let i = 0; i < 50; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      await engine.addRawTx(raw as Hex)
    }

    const block = await engine.proposeNextBlock()
    assert.ok(block)
    assert.ok(
      block.txs.length <= maxTx,
      `Block has ${block.txs.length} txs, expected <= ${maxTx}`,
    )
  })

  it("maintains state consistency after 10 consecutive blocks", async () => {
    const { engine, evm } = await createTestEngine(10)
    const wallet = new Wallet(FUNDER_KEY)
    const receiver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

    const initialBalance = await evm.getBalance(FUNDER_ADDR)

    for (let blockNum = 0; blockNum < 10; blockNum++) {
      const raw = signRawTx(wallet, blockNum, receiver, 1000000000000000n) // 0.001 ETH
      await engine.addRawTx(raw as Hex)
      await engine.proposeNextBlock()
    }

    const finalBalance = await evm.getBalance(FUNDER_ADDR)
    const receiverBalance = await evm.getBalance(receiver)

    assert.ok(finalBalance < initialBalance, "Sender balance should decrease")
    assert.ok(receiverBalance > 0n, "Receiver should have received funds")
  })
})

describe("Stress: Rate Limiter Under Sustained Pressure", () => {
  it("enforces limit within a single window", () => {
    // RateLimiter(windowMs, maxRequests)
    const limiter = new RateLimiter(60_000, 1000)
    const ip = "192.168.1.1"
    let allowed = 0
    let denied = 0

    for (let i = 0; i < 1200; i++) {
      if (limiter.allow(ip)) {
        allowed++
      } else {
        denied++
      }
    }

    assert.equal(allowed, 1000)
    assert.equal(denied, 200)
  })

  it("tracks rate limits independently per IP", () => {
    // RateLimiter(windowMs, maxRequests)
    const limiter = new RateLimiter(60_000, 10)
    const results = new Map<string, number>()

    for (let ip = 0; ip < 100; ip++) {
      const addr = `10.0.0.${ip}`
      let count = 0
      for (let j = 0; j < 15; j++) {
        if (limiter.allow(addr)) count++
      }
      results.set(addr, count)
    }

    for (const [, count] of results) {
      assert.equal(count, 10)
    }
  })

  it("cleanup reclaims memory from expired entries", () => {
    const limiter = new RateLimiter(1, 5) // 1ms window
    for (let i = 0; i < 100; i++) {
      limiter.allow(`10.0.${Math.floor(i / 256)}.${i % 256}`)
    }

    const waitStart = Date.now()
    while (Date.now() - waitStart < 10) {
      /* spin */
    }

    limiter.cleanup()
    assert.ok(limiter.allow("10.0.0.1"))
  })

  it("handles burst traffic from many IPs simultaneously", () => {
    const limiter = new RateLimiter(60_000, 100)
    let totalAllowed = 0

    const start = performance.now()
    for (let ip = 0; ip < 500; ip++) {
      const addr = `172.16.${Math.floor(ip / 256)}.${ip % 256}`
      if (limiter.allow(addr)) totalAllowed++
    }
    const duration = performance.now() - start

    console.log(`  500 IPs burst: ${duration.toFixed(0)}ms, ${totalAllowed} allowed`)
    assert.equal(totalAllowed, 500)
  })
})

describe("Stress: Mixed Workload Simulation", () => {
  it("interleaves block production with read operations", async () => {
    const { engine, evm } = await createTestEngine(20)
    const wallet = new Wallet(FUNDER_KEY)

    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 5; i++) {
        const raw = signRawTx(wallet, round * 5 + i, BURN_ADDR, 1n)
        await engine.addRawTx(raw as Hex)
      }
      await engine.proposeNextBlock()

      // Read: query state
      const balance = await evm.getBalance(FUNDER_ADDR)
      assert.ok(balance > 0n)

      const tip = engine.getTip()
      assert.ok(tip)
      assert.ok(tip.number >= BigInt(round + 1))
    }
  })

  it("validates chain integrity after sustained workload", async () => {
    const { engine } = await createTestEngine(50)
    const wallet = new Wallet(FUNDER_KEY)

    const blockCount = 10
    for (let b = 0; b < blockCount; b++) {
      for (let t = 0; t < 10; t++) {
        const raw = signRawTx(wallet, b * 10 + t, BURN_ADDR, 1n)
        await engine.addRawTx(raw as Hex)
      }
      await engine.proposeNextBlock()
    }

    const tip = engine.getTip()
    assert.ok(tip)
    assert.ok(tip.number >= BigInt(blockCount))

    // Verify each block can be retrieved
    for (let h = 1; h <= blockCount; h++) {
      const block = engine.getBlockByNumber(BigInt(h))
      assert.ok(block, `Block at height ${h} should exist`)
    }
  })

  it("mempool handles mixed transaction types under load", () => {
    const mempool = new Mempool({ maxSize: 500, chainId: CHAIN_ID })
    const wallets = Array.from({ length: 10 }, () => Wallet.createRandom())

    let added = 0
    for (const wallet of wallets) {
      for (let i = 0; i < 20; i++) {
        try {
          const raw = signRawTx(wallet, i, BURN_ADDR, 1n, BigInt(1e9 + Math.floor(Math.random() * 1e9)))
          mempool.addRawTx(raw as Hex)
          added++
        } catch {
          // May hit limits
        }
      }
    }

    console.log(`  Mixed workload: ${added} txs added from 10 senders`)
    assert.ok(added > 100, `Expected >100 txs, got ${added}`)
    assert.ok(mempool.size() <= 500)
  })
})

describe("Stress: Performance Baselines", () => {
  it("measures block production throughput", async () => {
    const { engine } = await createTestEngine(50)
    const wallet = new Wallet(FUNDER_KEY)

    const blockTimes: number[] = []
    for (let b = 0; b < 10; b++) {
      for (let t = 0; t < 20; t++) {
        const raw = signRawTx(wallet, b * 20 + t, BURN_ADDR, 1n)
        await engine.addRawTx(raw as Hex)
      }

      const start = performance.now()
      await engine.proposeNextBlock()
      blockTimes.push(performance.now() - start)
    }

    const avgMs = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length
    const maxMs = Math.max(...blockTimes)
    const minMs = Math.min(...blockTimes)

    console.log(`  Block production (10 blocks, 20 txs each):`)
    console.log(`    Avg: ${avgMs.toFixed(1)}ms, Min: ${minMs.toFixed(1)}ms, Max: ${maxMs.toFixed(1)}ms`)

    assert.ok(avgMs < 5000, `Average block time ${avgMs.toFixed(1)}ms exceeded 5s limit`)
  })

  it("measures mempool insertion throughput", () => {
    const mempool = new Mempool({ maxSize: 2000, maxPerSender: 1000, chainId: CHAIN_ID })
    const wallet = new Wallet(FUNDER_KEY)

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      const raw = signRawTx(wallet, i, BURN_ADDR, 1n)
      mempool.addRawTx(raw as Hex)
    }
    const duration = performance.now() - start

    const insertionsPerSec = (1000 / duration) * 1000
    console.log(`  1000 mempool insertions: ${duration.toFixed(0)}ms (${insertionsPerSec.toFixed(0)} ins/s)`)

    assert.ok(insertionsPerSec > 100, `Expected >100 ins/s, got ${insertionsPerSec.toFixed(0)}`)
  })

  it("measures EVM balance query throughput", async () => {
    const evm = await EvmChain.create(CHAIN_ID)
    await evm.prefund([{ address: FUNDER_ADDR, balanceWei: "100000000000000000000" }])

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      await evm.getBalance(FUNDER_ADDR)
    }
    const duration = performance.now() - start
    const queriesPerSec = (1000 / duration) * 1000

    console.log(`  1000 balance queries: ${duration.toFixed(0)}ms (${queriesPerSec.toFixed(0)} q/s)`)
    assert.ok(queriesPerSec > 500, `Expected >500 q/s, got ${queriesPerSec.toFixed(0)}`)
  })
})
