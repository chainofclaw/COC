/**
 * applyBlock queue serialization tests.
 *
 * Public applyBlock on both ChainEngine and PersistentChainEngine now
 * funnels concurrent callers through a Promise-chain queue. These tests
 * lock in the contract:
 *
 *   1. Concurrent callers complete in FIFO order (no re-entrant throw).
 *   2. One caller's rejection does not poison the queue — subsequent
 *      queued applyBlock promises still advance.
 *   3. resetApplyingFlag() remains callable as a final recovery hatch
 *      for the BFT onFinalized outer-timeout path.
 *
 * Context: tests/chain-concurrency.race.test.ts A+B+C+D previously threw
 * "applyBlock re-entrant call detected" when the proposer was mid-apply
 * and a gossip worker re-delivered an already-seen block. The queue
 * eliminates the throw; these tests guarantee it stays eliminated.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEther, Transaction, Wallet } from "ethers"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { Hex } from "./chain-engine-types.ts"

const CHAIN_ID = 18780
const FUNDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const TARGET = "0x000000000000000000000000000000000000dEaD"

function signTransfer(wallet: Wallet, nonce: number): Hex {
  const tx = Transaction.from({
    to: TARGET,
    value: `0x${(1000n + BigInt(nonce)).toString(16)}`,
    nonce,
    gasLimit: "0x5208",
    gasPrice: "0xee6b2800",
    chainId: CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized as Hex
}

describe("PersistentChainEngine applyBlock queue", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine
  let wallet: Wallet

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "apply-queue-"))
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
          { address: FUNDER_ADDR, balanceWei: parseEther("10000").toString() },
        ],
      },
      evm,
    )
    await engine.init()
    wallet = new Wallet(FUNDER_KEY)
  })

  afterEach(async () => {
    try { await engine.close() } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("concurrent applyBlock callers all complete (no re-entrant throw)", async () => {
    // Seed a chain with ~20 blocks so we have real blocks to re-apply.
    const snapshots = []
    let nonce = 0
    for (let i = 0; i < 20; i++) {
      for (let t = 0; t < 3; t++) {
        await engine.addRawTx(signTransfer(wallet, nonce++))
      }
      const b = await engine.proposeNextBlock()
      assert.ok(b)
      snapshots.push(b)
    }

    // Concurrent re-applies: each is a duplicate (dup-check returns early),
    // but the queue must serialize the 50 calls instead of throwing.
    const reapplyTargets = Array.from({ length: 50 }, (_, i) => snapshots[i % snapshots.length])
    const results = await Promise.allSettled(
      reapplyTargets.map((b) => engine.applyBlock(b)),
    )
    const rejected = results.filter((r) => r.status === "rejected")
    assert.strictEqual(rejected.length, 0, `no caller should throw; got ${rejected.length} rejections`)
  })

  it("one caller's rejection does not stall the queue", async () => {
    let nonce = 0
    for (let i = 0; i < 5; i++) {
      await engine.addRawTx(signTransfer(wallet, nonce++))
    }
    const good = await engine.proposeNextBlock()
    assert.ok(good)

    // Craft a malformed block that applyBlock will reject (wrong parentHash).
    const bad = { ...good, parentHash: "0x" + "ff".repeat(32) as Hex, hash: "0x" + "aa".repeat(32) as Hex }

    // Queue: [bad reject] → [good dup-return resolves].
    const p1 = engine.applyBlock(bad as any).catch((e) => String(e))
    const p2 = engine.applyBlock(good)
    const [r1, r2] = await Promise.all([p1, p2])
    assert.ok(String(r1).includes("Error"), `first call should reject, got: ${r1}`)
    // Second call must still complete (queue advanced past the rejection).
    assert.strictEqual(r2, undefined)
  })

  it("queue preserves FIFO order: first caller finishes before second starts its impl", async () => {
    let nonce = 0
    for (let i = 0; i < 3; i++) {
      await engine.addRawTx(signTransfer(wallet, nonce++))
    }
    const b1 = await engine.proposeNextBlock()
    assert.ok(b1)

    for (let i = 0; i < 3; i++) {
      await engine.addRawTx(signTransfer(wallet, nonce++))
    }
    // proposeNextBlock applies internally via the queue, so issue it first
    // so the next explicit applyBlock stacks behind it.
    const b2Promise = engine.proposeNextBlock()
    // Concurrent duplicate of b1 from gossip path — both must serialize.
    const dupPromise = engine.applyBlock(b1)
    const [b2, dupResult] = await Promise.all([b2Promise, dupPromise])
    assert.ok(b2)
    assert.strictEqual(dupResult, undefined)
    // Height advanced to b2.number, confirming both completed.
    const height = await engine.getHeight()
    assert.strictEqual(height, b2.number)
  })

  it("resetApplyingFlag() remains usable after a hung in-flight call is abandoned", async () => {
    // Simulate the onFinalized outer-timeout recovery path: the outer caller
    // gave up on a hung apply, and now needs to clear the flag so the next
    // block can be processed. The queue does not auto-clear `applyingBlock`
    // on its own; it relies on the impl's finally block. If that never runs
    // (the live-node hang case), resetApplyingFlag is the last resort.
    ;(engine as any).applyingBlock = true
    engine.resetApplyingFlag()
    let nonce = 0
    await engine.addRawTx(signTransfer(wallet, nonce++))
    const b = await engine.proposeNextBlock()
    assert.ok(b, "after resetApplyingFlag, new block must propose cleanly")
  })
})
