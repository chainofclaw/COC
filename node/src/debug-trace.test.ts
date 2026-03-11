/**
 * Debug/Trace API tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { Hex } from "./blockchain-types.ts"
import { traceTransaction, traceBlockByNumber, traceTransactionCalls } from "./debug-trace.ts"
import { Wallet, getCreateAddress, parseEther, Transaction } from "ethers"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const GAS_PRICE = 1_000_000_000n
const INIT_CODE = "0x602a600055600b6011600039600b6000f360005460005260206000f3"

async function deployStorageContract(engine: PersistentChainEngine): Promise<string> {
  const wallet = new Wallet(FUNDED_PK)
  const deployTx = await wallet.signTransaction({
    data: INIT_CODE,
    gasLimit: 200_000,
    gasPrice: GAS_PRICE,
    nonce: 0,
    chainId: CHAIN_ID,
  })
  await engine.addRawTx(deployTx as Hex)
  await engine.proposeNextBlock()
  return getCreateAddress({ from: wallet.address, nonce: 0 })
}

async function callStorageContract(engine: PersistentChainEngine, contractAddress: string): Promise<Hex> {
  const wallet = new Wallet(FUNDED_PK)
  const callTx = await wallet.signTransaction({
    to: contractAddress,
    data: "0x",
    gasLimit: 100_000,
    gasPrice: GAS_PRICE,
    nonce: 1,
    chainId: CHAIN_ID,
  })
  await engine.addRawTx(callTx as Hex)
  await engine.proposeNextBlock()
  return Transaction.from(callTx).hash as Hex
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
    const contractAddress = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)
    const trace = await traceTransaction(callTxHash, engine, evm)

    assert.ok(trace)
    assert.equal(trace.failed, false)
    assert.ok(trace.gas > 0)
    assert.ok(trace.structLogs.length > 1)
    assert.ok(trace.structLogs.some((step) => step.op === "SLOAD"))
    assert.equal(trace.returnValue, `0x${"0".repeat(62)}2a`)
  })

  it("traceTransaction throws for non-existent tx", async () => {
    await assert.rejects(
      () => traceTransaction("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, engine, evm),
      /transaction not found/,
    )
  })

  it("traceBlockByNumber traces all txs in a block", async () => {
    const contractAddress = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)

    const traces = await traceBlockByNumber(2n, engine, evm)
    assert.equal(traces.length, 1)
    assert.equal(traces[0].txHash, callTxHash)
    assert.equal(traces[0].result.failed, false)
    assert.ok(traces[0].result.structLogs.some((step) => step.op === "SLOAD"))
  })

  it("traceBlockByNumber throws for non-existent block", async () => {
    await assert.rejects(
      () => traceBlockByNumber(999n, engine, evm),
      /block not found/,
    )
  })

  it("traceTransactionCalls returns call trace", async () => {
    const contractAddress = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)
    const calls = await traceTransactionCalls(callTxHash, engine, evm)

    assert.ok(calls.length > 0)
    assert.equal(calls[0].type, "call")
    assert.ok(calls[0].from.startsWith("0x"))
    assert.equal(calls[0].to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(calls[0].error, undefined) // successful tx
    assert.equal(calls[0].input, "0x")
    assert.equal(calls[0].output, `0x${"0".repeat(62)}2a`)
  })
})
