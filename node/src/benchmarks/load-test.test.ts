/**
 * Performance & Load Tests
 *
 * Comprehensive benchmarks covering:
 * - Block production throughput
 * - Transaction processing rate
 * - Mempool operations under load
 * - Storage I/O performance
 * - Concurrent RPC handling
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { EvmChain } from "../evm.ts"
import { PersistentChainEngine } from "../chain-engine-persistent.ts"
import { Mempool } from "../mempool.ts"
import { MemoryDatabase } from "../storage/db.ts"
import { BlockIndex } from "../storage/block-index.ts"
import type { Hex } from "../blockchain-types.ts"
import { Wallet, Transaction, parseEther } from "ethers"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const TARGET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

function createSignedTx(nonce: number, valueWei: bigint): Hex {
  const wallet = new Wallet(FUNDED_PK)
  const tx = Transaction.from({
    to: TARGET,
    value: `0x${valueWei.toString(16)}`,
    nonce,
    gasLimit: "0x5208",
    gasPrice: "0x3b9aca00",
    chainId: CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized as Hex
}

describe("Block Production Throughput", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "load-test-"))
    evm = await EvmChain.create(CHAIN_ID)
    engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth: 2,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
        prefundAccounts: [
          { address: FUNDED_ADDRESS, balanceWei: parseEther("100000").toString() },
        ],
      },
      evm,
    )
    await engine.init()
  })

  afterEach(async () => {
    await engine.close()
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("produces 10 blocks with 5 txs each under 5 seconds", async () => {
    const start = performance.now()
    let nonce = 0

    for (let block = 0; block < 10; block++) {
      for (let tx = 0; tx < 5; tx++) {
        const rawTx = createSignedTx(nonce++, BigInt(1000 + tx))
        await engine.addRawTx(rawTx)
      }
      const result = await engine.proposeNextBlock()
      assert.ok(result, `block ${block} should be produced`)
    }

    const duration = performance.now() - start
    const blocksPerSec = (10 / duration) * 1000
    console.log(`  10 blocks (5 txs each): ${duration.toFixed(0)}ms (${blocksPerSec.toFixed(1)} blocks/sec)`)
    assert.ok(duration < 5000, `block production took ${duration.toFixed(0)}ms, expected < 5000ms`)
  })

  it("processes 50 transactions sequentially under 10 seconds", async () => {
    const start = performance.now()

    for (let i = 0; i < 50; i++) {
      const rawTx = createSignedTx(i, BigInt(1000 + i))
      await engine.addRawTx(rawTx)
    }

    const block = await engine.proposeNextBlock()
    assert.ok(block)
    assert.ok(block!.txs.length > 0)

    const duration = performance.now() - start
    const tps = (50 / duration) * 1000
    console.log(`  50 txs + 1 block: ${duration.toFixed(0)}ms (${tps.toFixed(1)} tx/sec)`)
    assert.ok(duration < 10000, `tx processing took ${duration.toFixed(0)}ms, expected < 10000ms`)
  })
})

describe("Mempool Performance", () => {
  it("handles 200 tx adds under 5 seconds", () => {
    const mempool = new Mempool({ chainId: CHAIN_ID, maxSize: 2000 })
    const wallet = new Wallet(FUNDED_PK)
    const start = performance.now()

    let added = 0
    for (let i = 0; i < 200; i++) {
      const tx = Transaction.from({
        to: TARGET,
        value: `0x${(1000 + i).toString(16)}`,
        nonce: i,
        gasLimit: "0x5208",
        gasPrice: `0x${(1000000000 + i).toString(16)}`,
        chainId: CHAIN_ID,
        data: "0x",
      })
      const signed = wallet.signingKey.sign(tx.unsignedHash)
      const clone = tx.clone()
      clone.signature = signed

      try {
        mempool.addRawTx(clone.serialized as Hex)
        added++
      } catch {
        // tx might be rejected
      }
    }

    const duration = performance.now() - start
    const rate = (added / duration) * 1000
    console.log(`  ${added} mempool adds: ${duration.toFixed(0)}ms (${rate.toFixed(0)} tx/sec)`)
    assert.ok(duration < 5000, `mempool adds took ${duration.toFixed(0)}ms`)
    assert.ok(added > 50, `expected > 50 successful adds, got ${added}`)
  })

  it("pickForBlock with mempool under 500ms", async () => {
    const mempool = new Mempool({ chainId: CHAIN_ID, maxSize: 2000 })
    const wallet = new Wallet(FUNDED_PK)

    // Fill mempool with 50 txs
    for (let i = 0; i < 50; i++) {
      const tx = Transaction.from({
        to: TARGET, value: "0x1", nonce: i,
        gasLimit: "0x5208", gasPrice: "0x3b9aca00",
        chainId: CHAIN_ID, data: "0x",
      })
      const signed = wallet.signingKey.sign(tx.unsignedHash)
      const clone = tx.clone()
      clone.signature = signed
      try { mempool.addRawTx(clone.serialized as Hex) } catch { /* skip */ }
    }

    const start = performance.now()
    const picked = await mempool.pickForBlock(
      20,
      async () => 0n, // mock on-chain nonce
      1n,
    )
    const duration = performance.now() - start

    console.log(`  pickForBlock from ${mempool.size()} txs: ${duration.toFixed(2)}ms, picked ${picked.length}`)
    assert.ok(duration < 500, `pickForBlock took ${duration.toFixed(2)}ms`)
    assert.ok(picked.length > 0)
  })
})

describe("Storage I/O Performance", () => {
  it("stores and retrieves 100 blocks under 500ms", async () => {
    const db = new MemoryDatabase()
    const blockIndex = new BlockIndex(db)
    const start = performance.now()

    for (let i = 1; i <= 100; i++) {
      await blockIndex.putBlock({
        number: BigInt(i),
        hash: `0x${i.toString(16).padStart(64, "0")}` as Hex,
        parentHash: `0x${(i - 1).toString(16).padStart(64, "0")}` as Hex,
        proposer: "node-1",
        txs: [],
        timestamp: Math.floor(Date.now() / 1000),
        final: false,
      })
    }

    // Read all back
    for (let i = 1; i <= 100; i++) {
      const block = await blockIndex.getBlockByNumber(BigInt(i))
      assert.ok(block)
    }

    const duration = performance.now() - start
    console.log(`  100 block write+read: ${duration.toFixed(0)}ms`)
    assert.ok(duration < 500, `storage I/O took ${duration.toFixed(0)}ms`)
  })

  it("stores and retrieves 200 transactions under 500ms", async () => {
    const db = new MemoryDatabase()
    const blockIndex = new BlockIndex(db)
    const start = performance.now()

    for (let i = 0; i < 200; i++) {
      const txHash = `0x${i.toString(16).padStart(64, "0")}` as Hex
      await blockIndex.putTransaction(txHash, {
        rawTx: "0x00" as Hex,
        receipt: {
          transactionHash: txHash,
          blockNumber: BigInt(Math.floor(i / 10)),
          blockHash: "0x00" as Hex,
          from: FUNDED_ADDRESS as Hex,
          to: TARGET as Hex,
          gasUsed: 21000n,
          status: 1n,
          logs: [],
        },
      })
    }

    // Read all back
    for (let i = 0; i < 200; i++) {
      const txHash = `0x${i.toString(16).padStart(64, "0")}` as Hex
      const tx = await blockIndex.getTransactionByHash(txHash)
      assert.ok(tx)
    }

    const duration = performance.now() - start
    console.log(`  200 tx write+read: ${duration.toFixed(0)}ms`)
    assert.ok(duration < 500, `tx storage I/O took ${duration.toFixed(0)}ms`)
  })
})

describe("EVM Concurrent Operations", () => {
  it("handles 20 parallel eth_call under 2 seconds", async () => {
    const evm = await EvmChain.create(CHAIN_ID)
    const start = performance.now()

    const calls = Array.from({ length: 20 }, () =>
      evm.callRaw({
        from: FUNDED_ADDRESS,
        to: TARGET,
        data: "0x",
      }),
    )

    await Promise.all(calls)

    const duration = performance.now() - start
    console.log(`  20 parallel eth_call: ${duration.toFixed(0)}ms`)
    assert.ok(duration < 2000, `parallel calls took ${duration.toFixed(0)}ms`)
  })

  it("handles 20 parallel estimateGas under 2 seconds", async () => {
    const evm = await EvmChain.create(CHAIN_ID)
    const start = performance.now()

    const estimates = Array.from({ length: 20 }, () =>
      evm.estimateGas({
        from: FUNDED_ADDRESS,
        to: TARGET,
        value: 1000n,
        data: "0x",
      }),
    )

    await Promise.all(estimates)

    const duration = performance.now() - start
    console.log(`  20 parallel estimateGas: ${duration.toFixed(0)}ms`)
    assert.ok(duration < 2000, `parallel estimates took ${duration.toFixed(0)}ms`)
  })
})
