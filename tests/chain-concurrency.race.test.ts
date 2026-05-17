/**
 * Integration race test for PersistentChainEngine.
 *
 * Target: reproduce the testnet applyBlock hang in isolation.
 *
 * Testnet hypothesis at this point: single isolated components
 * (PersistentStateManager, stock @ethereumjs/vm runTx) all complete
 * quickly in isolation. The hang only appears under the live node's
 * combination of:
 *   (A) sustained single-sender nonce increment (cron-stress deployer)
 *   (B) concurrent RPC reads (getAccount / getBlockByHash)
 *   (C) concurrent tx ingress to mempool (gossip simulation)
 *   (D) proposer loop calling proposeNextBlock+applyBlock back-to-back
 *
 * This harness stands up a real PersistentChainEngine backed by a real
 * LevelDatabase (mimicking testnet storage) and launches A-D as
 * parallel async workers for a bounded duration. A hang presents as
 * the outer 60s wall-clock timeout firing; a healthy run completes
 * well under that bound.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Transaction, Wallet, parseEther } from "ethers"
import { EvmChain } from "../node/src/evm.ts"
import { PersistentChainEngine } from "../node/src/chain-engine-persistent.ts"
import { LevelDatabase } from "../node/src/storage/db.ts"
import { PersistentStateTrie } from "../node/src/storage/state-trie.ts"
import { PersistentStateManager } from "../node/src/storage/persistent-state-manager.ts"
import type { Hex } from "../node/src/chain-engine-types.ts"

const CHAIN_ID = 18780
const FUNDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const TARGET = "0x000000000000000000000000000000000000dEaD"
const OUTER_TIMEOUT_MS = 60_000
const WORKER_DURATION_MS = 30_000

function signTx(wallet: Wallet, nonce: number): Hex {
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

async function withDeadline<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`${label}: outer deadline ${OUTER_TIMEOUT_MS}ms exceeded (HANG SUSPECTED)`)),
      OUTER_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([p, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("chain-concurrency race (reproduce testnet applyBlock hang)", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine
  let wallet: Wallet

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "chain-race-"))
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
          { address: FUNDER_ADDR, balanceWei: parseEther("1000000").toString() },
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

  it("A+B: 200 single-sender nonce-incrementing tx + proposer loop completes", async () => {
    const stats = { txSent: 0, blocksProduced: 0, reads: 0 }

    await withDeadline("A+B", (async () => {
      const deadline = Date.now() + WORKER_DURATION_MS
      let nonce = 0

      const txWorker = (async () => {
        while (Date.now() < deadline && nonce < 200) {
          try {
            await engine.addRawTx(signTx(wallet, nonce))
            stats.txSent++
            nonce++
          } catch {
            await new Promise((r) => setTimeout(r, 5))
          }
        }
      })()

      const proposerWorker = (async () => {
        while (Date.now() < deadline) {
          const b = await engine.proposeNextBlock()
          if (b) stats.blocksProduced++
          else await new Promise((r) => setTimeout(r, 10))
        }
      })()

      await Promise.all([txWorker, proposerWorker])
    })())

    console.log(`  A+B: txSent=${stats.txSent} blocks=${stats.blocksProduced}`)
    assert.ok(stats.txSent > 50, `expected >50 tx, got ${stats.txSent}`)
    assert.ok(stats.blocksProduced > 5, `expected >5 blocks, got ${stats.blocksProduced}`)
  })

  it("A+B+C: add tx + propose + concurrent RPC-style reads completes", async () => {
    const stats = { txSent: 0, blocksProduced: 0, reads: 0 }

    await withDeadline("A+B+C", (async () => {
      const deadline = Date.now() + WORKER_DURATION_MS
      let nonce = 0

      const txWorker = (async () => {
        while (Date.now() < deadline && nonce < 500) {
          try {
            await engine.addRawTx(signTx(wallet, nonce))
            stats.txSent++
            nonce++
          } catch {
            await new Promise((r) => setTimeout(r, 5))
          }
        }
      })()

      const proposerWorker = (async () => {
        while (Date.now() < deadline) {
          const b = await engine.proposeNextBlock()
          if (b) stats.blocksProduced++
          else await new Promise((r) => setTimeout(r, 10))
        }
      })()

      // Three reader workers hammering different RPC-style paths concurrently
      const readWorkers = [0, 1, 2].map(() => (async () => {
        while (Date.now() < deadline) {
          try {
            await engine.getTip()
            await engine.getHeight()
            stats.reads += 2
          } catch {}
          await new Promise((r) => setTimeout(r, 1))
        }
      })())

      await Promise.all([txWorker, proposerWorker, ...readWorkers])
    })())

    console.log(`  A+B+C: txSent=${stats.txSent} blocks=${stats.blocksProduced} reads=${stats.reads}`)
    assert.ok(stats.txSent > 50 && stats.blocksProduced > 5 && stats.reads > 1000)
  })

  it("A+B+C+D: add tx + propose + reads + gossip-style applyBlock re-delivery completes", async () => {
    const stats = { txSent: 0, blocksProduced: 0, reads: 0, reapplies: 0 }
    const seenBlocks: Array<{ number: bigint; hash: Hex }> = []

    await withDeadline("A+B+C+D", (async () => {
      const deadline = Date.now() + WORKER_DURATION_MS
      let nonce = 0

      const txWorker = (async () => {
        while (Date.now() < deadline && nonce < 500) {
          try {
            await engine.addRawTx(signTx(wallet, nonce))
            stats.txSent++
            nonce++
          } catch {
            await new Promise((r) => setTimeout(r, 5))
          }
        }
      })()

      const proposerWorker = (async () => {
        while (Date.now() < deadline) {
          const b = await engine.proposeNextBlock()
          if (b) {
            stats.blocksProduced++
            seenBlocks.push({ number: b.number, hash: b.hash })
          } else {
            await new Promise((r) => setTimeout(r, 10))
          }
        }
      })()

      const readWorkers = [0, 1, 2].map(() => (async () => {
        while (Date.now() < deadline) {
          try {
            await engine.getTip()
            stats.reads++
          } catch {}
          await new Promise((r) => setTimeout(r, 1))
        }
      })())

      // Gossip simulation: re-apply a previously-seen block to exercise
      // the duplicate-detection path in applyBlock concurrently with the
      // proposer. On testnet, BFT re-broadcasts a block when its round
      // times out; this worker mimics that race.
      const gossipWorker = (async () => {
        while (Date.now() < deadline) {
          if (seenBlocks.length > 0) {
            const pick = seenBlocks[seenBlocks.length - 1]
            try {
              const full = await engine.getBlockByHash(pick.hash)
              if (full) {
                await engine.applyBlock(full)
                stats.reapplies++
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 3))
        }
      })()

      await Promise.all([txWorker, proposerWorker, gossipWorker, ...readWorkers])
    })())

    console.log(`  A+B+C+D: txSent=${stats.txSent} blocks=${stats.blocksProduced} reads=${stats.reads} reapplies=${stats.reapplies}`)
    assert.ok(stats.txSent > 50 && stats.blocksProduced > 5)
  })

})

/**
 * #642 regression — stateRoot divergence under a concurrent tx burst.
 *
 * Unlike the harness above (which runs the engine with no separate persistent
 * state trie), this suite wires the FULL persistent stack — a
 * PersistentStateTrie-backed EVM — so speculativelyComputeStateRoot exercises
 * the real fork/flush path that #642 corrupts.
 */
describe("#642 — speculative stateRoot consistency under concurrent burst", () => {
  let tmpDir: string
  let stateDb: LevelDatabase
  let evm: EvmChain
  let engine: PersistentChainEngine
  let wallet: Wallet

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "stateroot-642-"))
    stateDb = new LevelDatabase(tmpDir, "state")
    await stateDb.open()
    const trie = new PersistentStateTrie(stateDb)
    await trie.init()
    const stateManager = new PersistentStateManager(trie)
    evm = await EvmChain.create(CHAIN_ID, stateManager)
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
          { address: FUNDER_ADDR, balanceWei: parseEther("1000000").toString() },
        ],
        stateTrie: trie,
      },
      evm,
    )
    await engine.init()
    wallet = new Wallet(FUNDER_KEY)
  })

  afterEach(async () => {
    try { await engine.close() } catch {}
    try { await stateDb.close() } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("speculative stateRoot agrees with applied root under concurrent load", async () => {
    // #642: a concurrent tx burst raced speculativelyComputeStateRoot's
    // shared-trie flush against an in-flight applyBlock, corrupting the
    // PersistentStateTrie so a node's speculative root diverged from the root
    // it actually committed — surfacing at the next empty block as a
    // proposer-vs-voter stateRoot mismatch and a permanent BFT deadlock.
    //
    // Invariant under test: for every proposed block, every non-undefined
    // speculativelyComputeStateRoot() result MUST equal the canonical
    // post-apply stateRoot — even while a burst of tx admissions and
    // gossip-style applyBlock re-deliveries run concurrently. A single
    // divergence is the bug.
    const stats = { blocks: 0, specChecks: 0, divergences: 0, reapplies: 0 }
    const seenBlocks: Array<{ number: bigint; hash: Hex }> = []

    await withDeadline("#642", (async () => {
      const deadline = Date.now() + WORKER_DURATION_MS
      let nonce = 0

      // Burst tx admission — keeps the mempool loaded so proposed blocks carry
      // txs (and drain to empty blocks, the exact #642 trigger surface).
      const txWorker = (async () => {
        while (Date.now() < deadline && nonce < 4000) {
          try { await engine.addRawTx(signTx(wallet, nonce)); nonce++ }
          catch { await new Promise((r) => setTimeout(r, 3)) }
        }
      })()

      // Proposer + 3-voter simulation: build the next block (unapplied), have
      // three concurrent voters speculatively compute its stateRoot — racing
      // each other and the gossip-applyBlock worker below — then apply it and
      // compare every speculative result against the canonical post-apply
      // root. With the shared-trie access serialized, all three voters and the
      // applied root must agree on every block; a divergence is the #642 bug.
      const proposerWorker = (async () => {
        while (Date.now() < deadline) {
          const block = await engine.proposeNextBlock(true /* deferApply */)
          if (!block) { await new Promise((r) => setTimeout(r, 8)); continue }
          const specRoots = await Promise.all([
            engine.speculativelyComputeStateRoot(block).catch(() => undefined),
            engine.speculativelyComputeStateRoot(block).catch(() => undefined),
            engine.speculativelyComputeStateRoot(block).catch(() => undefined),
          ])
          await engine.applyBlock(block, true)
          const applied = await engine.getBlockByHash(block.hash)
          const canonical = applied?.stateRoot
          stats.blocks++
          seenBlocks.push({ number: block.number, hash: block.hash })
          for (const r of specRoots) {
            if (r === undefined) continue // fail-open (parent moved) — allowed
            stats.specChecks++
            if (canonical !== undefined && r !== canonical) stats.divergences++
          }
        }
      })()

      // Gossip-style concurrent applyBlock — re-delivers recent blocks so an
      // applyBlock checkpoint overlaps the speculative computes above (this is
      // the interleave that corrupted the shared trie pre-fix).
      const gossipWorker = (async () => {
        while (Date.now() < deadline) {
          const pick = seenBlocks[seenBlocks.length - 1]
          if (pick) {
            try {
              const full = await engine.getBlockByHash(pick.hash)
              if (full) { await engine.applyBlock(full); stats.reapplies++ }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 2))
        }
      })()

      await Promise.all([txWorker, proposerWorker, gossipWorker])
    })())

    console.log(`  #642: blocks=${stats.blocks} specChecks=${stats.specChecks} divergences=${stats.divergences} reapplies=${stats.reapplies}`)
    assert.ok(stats.blocks > 5, `expected >5 blocks, got ${stats.blocks}`)
    assert.ok(stats.specChecks > 10, `expected >10 speculative checks, got ${stats.specChecks}`)
    assert.equal(stats.divergences, 0, `#642: speculative stateRoot diverged from applied root ${stats.divergences}x`)
  })
})
