/**
 * Debug/Trace API tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { Hex } from "./blockchain-types.ts"
import { traceTransaction, traceBlockByNumber, traceTransactionCalls } from "./debug-trace.ts"
import { Wallet, parseEther, Transaction } from "ethers"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

const TARGET_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

function createSignedTx(nonce: number, valueWei: bigint): Hex {
  const wallet = new Wallet(FUNDED_PK)
  const tx = Transaction.from({
    to: TARGET_ADDR,
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

describe("Debug/Trace APIs", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "debug-trace-test-"))
    evm = await EvmChain.create(CHAIN_ID)
    engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth: 2,
        maxTxPerBlock: 50,
        minGasPriceWei: 1n,
        prefundAccounts: [
          { address: FUNDED_ADDRESS, balanceWei: parseEther("10000").toString() },
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

  it("traceTransaction returns trace for confirmed tx", async () => {
    const rawTx = createSignedTx(0, 1000n)
    await engine.addRawTx(rawTx)
    const block = await engine.proposeNextBlock()
    assert.ok(block)

    const parsed = Transaction.from(block!.txs[0])
    const trace = await traceTransaction(parsed.hash as Hex, engine, evm)

    assert.ok(trace)
    assert.equal(trace.failed, false)
    assert.ok(trace.gas > 0)
    assert.ok(trace.structLogs.length > 0)
    assert.equal(trace.structLogs[0].op, "STOP")
  })

  it("traceTransaction throws for non-existent tx", async () => {
    await assert.rejects(
      () => traceTransaction("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, engine, evm),
      /transaction not found/,
    )
  })

  it("traceBlockByNumber traces all txs in a block", async () => {
    const rawTx1 = createSignedTx(0, 1000n)
    const rawTx2 = createSignedTx(1, 2000n)
    await engine.addRawTx(rawTx1)
    await engine.addRawTx(rawTx2)
    await engine.proposeNextBlock()

    const traces = await traceBlockByNumber(1n, engine, evm)
    assert.ok(traces.length >= 1) // may batch into one block
    for (const t of traces) {
      assert.ok(t.txHash.startsWith("0x"))
      assert.equal(t.result.failed, false)
    }
  })

  it("traceBlockByNumber throws for non-existent block", async () => {
    await assert.rejects(
      () => traceBlockByNumber(999n, engine, evm),
      /block not found/,
    )
  })

  it("traceTransactionCalls returns call trace", async () => {
    const rawTx = createSignedTx(0, 1000n)
    await engine.addRawTx(rawTx)
    const block = await engine.proposeNextBlock()
    assert.ok(block)

    const parsed = Transaction.from(block!.txs[0])
    const calls = await traceTransactionCalls(parsed.hash as Hex, engine, evm)

    assert.ok(calls.length > 0)
    assert.equal(calls[0].type, "call")
    assert.ok(calls[0].from.startsWith("0x"))
    assert.ok(calls[0].to.startsWith("0x"))
    assert.equal(calls[0].error, undefined) // successful tx
  })
})
