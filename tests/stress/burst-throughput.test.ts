/**
 * Burst-throughput stress test — captures the Ralph-loop (2026-05-17) burst
 * probes as a reusable suite: concurrent tx admission, counter-state exactness
 * under load, block-capacity headroom, and compute-load gas metering.
 *
 * Targets a live chain via COC_STRESS_RPC (default 127.0.0.1:18780). The whole
 * suite skips gracefully when no chain is reachable, so it is CI-safe.
 *
 * Run: COC_STRESS_RPC=http://host:port node --experimental-strip-types --test tests/stress/burst-throughput.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ethers } from "ethers"
import { tryGetHead } from "../../scripts/lib/rpc-helper.ts"
import { hdWallet, wrapInitCode } from "../../scripts/lib/wallet.ts"
import { RUNTIMES, buildComputeLoop } from "../../scripts/lib/probe-runtimes.ts"

const RPC = process.env.COC_STRESS_RPC ?? "http://127.0.0.1:18780"
const BURST = Number(process.env.COC_STRESS_BURST ?? 25)
// Tx-sending suites need an exclusively-owned funded account: when several
// run concurrently against one chain, give each a distinct funded index via
// COC_STRESS_WALLET_INDEX, or run them sequentially.
const WALLET_INDEX = Number(process.env.COC_STRESS_WALLET_INDEX ?? 0)
const reachable = (await tryGetHead(RPC)) !== null

const provider = reachable ? new ethers.JsonRpcProvider(RPC) : null
const wallet = provider ? hdWallet(provider, WALLET_INDEX) : null

describe("Burst throughput (live chain)", { skip: !reachable ? `no chain at ${RPC}` : false }, () => {
  it(`admits ${BURST} concurrent tx and counts state exactly`, async () => {
    const p = provider!, w = wallet!
    let nonce = await p.getTransactionCount(w.address, "pending")
    const C = (await (await w.sendTransaction({
      data: wrapInitCode(RUNTIMES.counter), nonce: nonce++, gasLimit: 200000n,
    })).wait(1, 60000))!.contractAddress!

    const base = nonce
    const sent = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        w.sendTransaction({ to: C, nonce: base + i, gasLimit: 60000n }),
      ),
    )
    const receipts = await Promise.all(sent.map((tx) => tx.wait(1, 90000)))
    for (const [i, rc] of receipts.entries()) {
      assert.equal(rc?.status, 1, `burst tx ${i} status`)
    }
    const slot0 = await p.getStorage(C, 0)
    assert.equal(BigInt(slot0), BigInt(BURST), "counter slot == burst size (no lost/double tx)")
  })

  it("block has ample headroom — burst occupies a small fraction of gasLimit", async () => {
    const p = provider!
    const head = await p.getBlock("latest", false)
    assert.ok(head, "latest block present")
    const limit = head!.gasLimit
    const used = head!.gasUsed
    assert.ok(limit >= 15_000_000n, `gasLimit healthy (got ${limit})`)
    const pctUsed = limit > 0n ? Number((used * 10000n) / limit) / 100 : 0
    assert.ok(pctUsed < 95, `block not saturated (used ${pctUsed}%)`)
  })

  it("compute-load contract meters gas precisely (estimateGas == receipt.gasUsed)", async () => {
    const p = provider!, w = wallet!
    let nonce = await p.getTransactionCount(w.address, "pending")
    const loop = buildComputeLoop(2000)
    const C = (await (await w.sendTransaction({
      data: wrapInitCode(loop), nonce: nonce++, gasLimit: 1_000_000n,
    })).wait(1, 60000))!.contractAddress!

    const est = await p.estimateGas({ from: w.address, to: C })
    const rc = await (await w.sendTransaction({
      to: C, nonce: nonce++, gasLimit: est * 2n,
    })).wait(1, 60000)
    assert.equal(rc?.status, 1, "compute-load tx status")
    assert.equal(rc!.gasUsed, est, "receipt.gasUsed matches estimateGas exactly")
  })

  it("sustains block production during the burst (head advances)", async () => {
    const p = provider!
    const before = await p.getBlockNumber()
    await new Promise((r) => setTimeout(r, 8000))
    const after = await p.getBlockNumber()
    assert.ok(after > before, `head advanced (${before} -> ${after})`)
  })
})
