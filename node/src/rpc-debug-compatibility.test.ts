import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wallet, getCreateAddress, parseEther, Transaction } from "ethers"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { Hex } from "./blockchain-types.ts"
import type { P2PNode } from "./p2p.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const GAS_PRICE = 1_000_000_000n
const INIT_CODE = "0x602a600055600b6011600039600b6000f360005460005260206000f3"

type RpcModule = typeof import("./rpc.ts")

async function deployStorageContract(engine: PersistentChainEngine): Promise<{ contractAddress: string; deployTxHash: Hex }> {
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

  return {
    contractAddress: getCreateAddress({ from: wallet.address, nonce: 0 }),
    deployTxHash: Transaction.from(deployTx).hash as Hex,
  }
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

describe("RPC debug compatibility", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine
  let rpc: RpcModule
  const p2p = { receiveTx: async () => {} } as P2PNode
  const originalDebugEnv = process.env.COC_DEBUG_RPC

  beforeEach(async () => {
    process.env.COC_DEBUG_RPC = "1"
    rpc = await import("./rpc.ts")
    tmpDir = await mkdtemp(join(tmpdir(), "rpc-debug-compat-"))
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
    if (originalDebugEnv === undefined) delete process.env.COC_DEBUG_RPC
    else process.env.COC_DEBUG_RPC = originalDebugEnv
  })

  it("debug_traceTransaction and trace_transaction expose replay-backed traces", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)

    const txTrace = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, {}],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      failed: boolean
      returnValue: string
      structLogs: Array<{ op: string }>
    }
    assert.equal(txTrace.failed, false)
    assert.equal(txTrace.returnValue, `0x${"0".repeat(62)}2a`)
    assert.ok(txTrace.structLogs.some((step) => step.op === "SLOAD"))

    const callTrace = await rpc.handleRpcMethod(
      "trace_transaction",
      [callTxHash],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      type: string
      to: string
      output: string
    }>
    assert.ok(callTrace.length > 0)
    assert.equal(callTrace[0].type, "call")
    assert.equal(callTrace[0].to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(callTrace[0].output, `0x${"0".repeat(62)}2a`)
  })

  it("debug_traceBlockByNumber returns opcode-level traces for block transactions", async () => {
    const { contractAddress, deployTxHash } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)

    const traces = await rpc.handleRpcMethod(
      "debug_traceBlockByNumber",
      ["0x2", {}],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      txHash: string
      result: {
        failed: boolean
        structLogs: Array<{ op: string }>
      }
    }>

    assert.equal(traces.length, 1)
    assert.equal(traces[0].txHash, callTxHash)
    assert.equal(traces[0].result.failed, false)
    assert.ok(traces[0].result.structLogs.some((step) => step.op === "SLOAD"))
    assert.notEqual(traces[0].txHash, deployTxHash)
  })
})
