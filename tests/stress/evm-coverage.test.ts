/**
 * EVM coverage stress test — captures the Ralph-loop (2026-05-17) EVM probes
 * as a reusable suite: runtime-pool deploy+execute, CREATE determinism,
 * factory (CREATE-from-contract), SELFDESTRUCT, and the tx-type matrix.
 *
 * Targets a live chain via COC_STRESS_RPC (default 127.0.0.1:18780). The whole
 * suite skips gracefully when no chain is reachable, so it is CI-safe.
 *
 * Run: COC_STRESS_RPC=http://host:port node --experimental-strip-types --test tests/stress/evm-coverage.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ethers } from "ethers"
import { rpcResult, tryGetHead, waitForReceipt } from "../../scripts/lib/rpc-helper.ts"
import { hdWallet, wrapInitCode, createAddress } from "../../scripts/lib/wallet.ts"
import { RUNTIMES, FACTORY_RET2A, buildSelfdestruct } from "../../scripts/lib/probe-runtimes.ts"

const RPC = process.env.COC_STRESS_RPC ?? "http://127.0.0.1:18780"
// Tx-sending suites need an exclusively-owned funded account: when several
// run concurrently against one chain, give each a distinct funded index via
// COC_STRESS_WALLET_INDEX, or run them sequentially.
const WALLET_INDEX = Number(process.env.COC_STRESS_WALLET_INDEX ?? 0)
const reachable = (await tryGetHead(RPC)) !== null

const provider = reachable ? new ethers.JsonRpcProvider(RPC) : null
const wallet = provider ? hdWallet(provider, WALLET_INDEX) : null

describe("EVM coverage (live chain)", { skip: !reachable ? `no chain at ${RPC}` : false }, () => {
  it("deploys + executes runtime-pool contracts", async () => {
    const p = provider!, w = wallet!
    let nonce = await p.getTransactionCount(w.address, "pending")
    for (const name of ["ret2a", "sstore", "counter", "log0", "timestamp"]) {
      const tx = await w.sendTransaction({ data: wrapInitCode(RUNTIMES[name]), nonce: nonce++, gasLimit: 250000n })
      const rc = await tx.wait(1, 60000)
      assert.equal(rc?.status, 1, `${name} deploy status`)
      const code = await p.getCode(rc!.contractAddress!)
      assert.equal(code, "0x" + RUNTIMES[name], `${name} runtime bytecode`)
    }
  })

  it("CREATE address is deterministic (factory pattern)", async () => {
    const p = provider!, w = wallet!
    let nonce = await p.getTransactionCount(w.address, "pending")
    const drc = await (await w.sendTransaction({ data: wrapInitCode(FACTORY_RET2A), nonce: nonce++, gasLimit: 300000n })).wait(1, 60000)
    const factory = drc!.contractAddress!
    const crc = await (await w.sendTransaction({ to: factory, nonce: nonce++, gasLimit: 300000n })).wait(1, 60000)
    assert.equal(crc?.status, 1, "factory invoke status")
    const slot0 = await p.getStorage(factory, 0)
    const childAddr = ethers.getAddress("0x" + slot0.slice(26))
    assert.equal(childAddr.toLowerCase(), createAddress(factory, 1).toLowerCase(), "child == keccak(rlp(factory,1))")
    assert.equal(await p.getCode(childAddr), "0x" + RUNTIMES.ret2a, "child runtime deployed")
  })

  it("SELFDESTRUCT deletes code + transfers balance (Shanghai)", async () => {
    const p = provider!, w = wallet!
    const beneficiary = ethers.Wallet.createRandom().address
    let nonce = await p.getTransactionCount(w.address, "pending")
    const fund = ethers.parseEther("0.001")
    const drc = await (await w.sendTransaction({ data: wrapInitCode(buildSelfdestruct(beneficiary)), nonce: nonce++, gasLimit: 250000n, value: fund })).wait(1, 60000)
    const s = drc!.contractAddress!
    assert.notEqual(await p.getCode(s), "0x", "pre: code present")
    await (await w.sendTransaction({ to: s, nonce: nonce++, gasLimit: 100000n })).wait(1, 60000)
    assert.equal(await p.getCode(s), "0x", "post: code deleted")
    assert.equal(await p.getBalance(beneficiary), fund, "balance transferred to beneficiary")
  })

  it("accepts tx types 0 / 1 / 2 with correct receipt.type", async () => {
    const p = provider!, w = wallet!
    const net = await p.getNetwork()
    let nonce = await p.getTransactionCount(w.address, "pending")
    const C = (await (await w.sendTransaction({ data: wrapInitCode(RUNTIMES.counter), nonce: nonce++, gasLimit: 200000n })).wait(1, 60000))!.contractAddress!
    const gp = 2_000_000_000n
    const variants = [
      { type: 0, txReq: { to: C, type: 0, gasPrice: gp } },
      { type: 1, txReq: { to: C, type: 1, gasPrice: gp, accessList: [{ address: C, storageKeys: ["0x" + "00".repeat(32)] }] } },
      { type: 2, txReq: { to: C, type: 2, maxFeePerGas: gp * 2n, maxPriorityFeePerGas: 1_000_000_000n } },
    ]
    for (const v of variants) {
      const rc = await (await w.sendTransaction({ ...v.txReq, nonce: nonce++, gasLimit: 60000n })).wait(1, 60000)
      assert.equal(rc?.status, 1, `type-${v.type} status`)
      const full = await p.getTransaction(rc!.hash)
      assert.equal(full?.type, v.type, `type-${v.type} receipt type`)
    }
  })

  it("rejects an unexecutable contract call with revert", async () => {
    const p = provider!, w = wallet!
    let nonce = await p.getTransactionCount(w.address, "pending")
    const C = (await (await w.sendTransaction({ data: wrapInitCode(RUNTIMES.revert), nonce: nonce++, gasLimit: 200000n })).wait(1, 60000))!.contractAddress!
    await assert.rejects(() => p.call({ to: C, data: "0x" }), "revert runtime must throw on eth_call")
  })

  it("chainId is exposed consistently as hex quantity", async () => {
    const hex = await rpcResult<string>(RPC, "eth_chainId")
    assert.match(hex, /^0x[0-9a-f]+$/, "eth_chainId hex-quantity format")
  })
})

void waitForReceipt // referenced for lint parity; receipt polling available to extenders
