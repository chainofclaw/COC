import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wallet, Interface, getCreateAddress, parseEther, Transaction } from "ethers"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { Hex } from "./blockchain-types.ts"
import type { P2PNode } from "./p2p.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const GAS_PRICE = 1_000_000_000n
const INIT_CODE = "0x602a600055600b6011600039600b6000f360005460005260206000f3"
const RUNTIME_CODE = "0x60005460005260206000f3"
const NESTED_CALL_SOURCE = `
pragma solidity ^0.8.0;

contract Callee {
    error NestedCustom(address caller, uint256 code);

    event Ping(uint256 value);

    function ping() external returns (uint256) {
        emit Ping(42);
        return 42;
    }

    function fail() external pure returns (uint256) {
        revert("nested nope");
    }

    function failCustom() external view returns (uint256) {
        revert NestedCustom(msg.sender, 7);
    }
}

contract Caller {
    function callPing(address callee) external returns (uint256) {
        return Callee(callee).ping();
    }

    function callFail(address callee) external returns (uint256) {
        return Callee(callee).fail();
    }

    function callFailCustom(address callee) external returns (uint256) {
        return Callee(callee).failCustom();
    }
}
`

type RpcModule = typeof import("./rpc.ts")
type CompiledContractArtifact = { abi: any[]; bytecode: string; runtimeCode: string }
type NestedCallArtifacts = {
  callee: CompiledContractArtifact
  caller: CompiledContractArtifact
}

let nestedCallArtifactsPromise: Promise<NestedCallArtifacts> | null = null

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

async function buildStorageContractCallTx(contractAddress: string, nonce: number): Promise<Hex> {
  const wallet = new Wallet(FUNDED_PK)
  return await wallet.signTransaction({
    to: contractAddress,
    data: "0x",
    gasLimit: 100_000,
    gasPrice: GAS_PRICE,
    nonce,
    chainId: CHAIN_ID,
  }) as Hex
}

async function compileNestedCallArtifacts(): Promise<NestedCallArtifacts> {
  if (!nestedCallArtifactsPromise) {
    nestedCallArtifactsPromise = import("solc")
      .then((module) => {
        const solc = (module.default ?? module) as { compile(input: string): string }
        const input = {
          language: "Solidity",
          sources: {
            "nested.sol": { content: NESTED_CALL_SOURCE },
          },
          settings: {
            outputSelection: {
              "*": {
                "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
              },
            },
          },
        }
        const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
          contracts?: Record<string, Record<string, {
            abi?: any[]
            evm?: {
              bytecode?: { object?: string }
              deployedBytecode?: { object?: string }
            }
          }>>
          errors?: Array<{ severity?: string; formattedMessage?: string; message?: string }>
        }
        const fatalErrors = (output.errors ?? []).filter((entry) => entry.severity === "error")
        if (fatalErrors.length > 0) {
          throw new Error(fatalErrors.map((entry) => entry.formattedMessage ?? entry.message ?? "solc error").join("\n"))
        }
        const contracts = output.contracts?.["nested.sol"]
        if (!contracts?.Callee || !contracts?.Caller) {
          throw new Error("nested call artifacts missing")
        }
        const toArtifact = (artifact: {
          abi?: any[]
          evm?: { bytecode?: { object?: string }; deployedBytecode?: { object?: string } }
        }): CompiledContractArtifact => ({
          abi: artifact.abi ?? [],
          bytecode: normalizeCompiledHex(artifact.evm?.bytecode?.object),
          runtimeCode: normalizeCompiledHex(artifact.evm?.deployedBytecode?.object),
        })
        return {
          callee: toArtifact(contracts.Callee),
          caller: toArtifact(contracts.Caller),
        }
      })
  }
  return nestedCallArtifactsPromise
}

function normalizeCompiledHex(value: string | undefined): string {
  return value && value.length > 0 ? `0x${value}` : "0x"
}

async function deployContract(engine: PersistentChainEngine, initCode: Hex, nonce: number): Promise<{ contractAddress: string; txHash: Hex }> {
  const wallet = new Wallet(FUNDED_PK)
  const deployTx = await wallet.signTransaction({
    data: initCode,
    gasLimit: 400_000,
    gasPrice: GAS_PRICE,
    nonce,
    chainId: CHAIN_ID,
  })
  await engine.addRawTx(deployTx as Hex)
  await engine.proposeNextBlock()
  return {
    contractAddress: getCreateAddress({ from: wallet.address, nonce }),
    txHash: Transaction.from(deployTx).hash as Hex,
  }
}

async function callContract(engine: PersistentChainEngine, to: string, data: Hex, nonce: number): Promise<Hex> {
  const wallet = new Wallet(FUNDED_PK)
  const callTx = await wallet.signTransaction({
    to,
    data,
    gasLimit: 300_000,
    gasPrice: GAS_PRICE,
    nonce,
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
      blockNumber: string
      transactionHash: string
      transactionPosition: string
      traceAddress: number[]
      action: { to: string; callType: string }
      result?: { output: string }
    }>
    assert.ok(callTrace.length > 0)
    assert.equal(callTrace[0].type, "call")
    assert.equal(callTrace[0].blockNumber, "0x2")
    assert.equal(callTrace[0].transactionHash, callTxHash)
    assert.equal(callTrace[0].transactionPosition, "0x0")
    assert.deepEqual(callTrace[0].traceAddress, [])
    assert.equal(callTrace[0].action.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(callTrace[0].action.callType, "call")
    assert.equal(callTrace[0].result?.output, `0x${"0".repeat(62)}2a`)
  })

  it("debug_traceCall and trace_call expose call-level replay data", async () => {
    const { contractAddress } = await deployStorageContract(engine)

    const callTrace = await rpc.handleRpcMethod(
      "debug_traceCall",
      [{ from: FUNDED_ADDRESS, to: contractAddress, data: "0x" }, "latest", {}],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      failed: boolean
      returnValue: string
      structLogs: Array<{ op: string }>
    }
    assert.equal(callTrace.failed, false)
    assert.equal(callTrace.returnValue, `0x${"0".repeat(62)}2a`)
    assert.ok(callTrace.structLogs.some((step) => step.op === "SLOAD"))

    const replay = await rpc.handleRpcMethod(
      "trace_call",
      [{ from: FUNDED_ADDRESS, to: contractAddress, data: "0x" }, ["trace", "vmTrace", "stateDiff"], "latest"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      output: string
      trace: Array<{
        type: string
        traceAddress: number[]
        subtraces: number
        action: { to: string; callType: string }
        result?: { output: string }
      }>
      vmTrace: { code: string | null; ops: Array<{ op: string; pc: number; sub: unknown }> }
      stateDiff: Record<string, unknown>
    }
    assert.equal(replay.output, `0x${"0".repeat(62)}2a`)
    assert.equal(replay.vmTrace.code, RUNTIME_CODE)
    assert.ok(replay.vmTrace.ops.length > 0)
    assert.ok(replay.vmTrace.ops.some((step) => step.op === "SLOAD"))
    assert.ok(replay.vmTrace.ops.every((step) => step.sub === null))
    assert.ok(replay.trace.length > 0)
    assert.equal(replay.trace[0].type, "call")
    assert.equal(replay.trace[0].traceAddress.length, 0)
    assert.equal(replay.trace[0].subtraces, 0)
    assert.equal(replay.trace[0].action.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(replay.trace[0].action.callType, "call")
    assert.equal(replay.trace[0].result?.output, `0x${"0".repeat(62)}2a`)
    assert.deepEqual(replay.stateDiff, {})
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

  it("debug_trace* supports callTracer output", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)

    const txTrace = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "callTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      type: string
      from: string
      to: string
      input: string
      output: string
      gas: string
      gasUsed: string
    }
    assert.equal(txTrace.type, "CALL")
    assert.equal(txTrace.from.toLowerCase(), FUNDED_ADDRESS.toLowerCase())
    assert.equal(txTrace.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(txTrace.input, "0x")
    assert.equal(txTrace.output, `0x${"0".repeat(62)}2a`)

    const callTrace = await rpc.handleRpcMethod(
      "debug_traceCall",
      [{ from: FUNDED_ADDRESS, to: contractAddress, data: "0x" }, "latest", { tracer: "callTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      type: string
      from: string
      to: string
      output: string
    }
    assert.equal(callTrace.type, "CALL")
    assert.equal(callTrace.from.toLowerCase(), FUNDED_ADDRESS.toLowerCase())
    assert.equal(callTrace.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(callTrace.output, `0x${"0".repeat(62)}2a`)

    const blockTraces = await rpc.handleRpcMethod(
      "debug_traceBlockByNumber",
      ["0x2", { tracer: "callTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      txHash: string
      result: {
        type: string
        to: string
        output: string
      }
    }>
    assert.equal(blockTraces.length, 1)
    assert.equal(blockTraces[0].txHash, callTxHash)
    assert.equal(blockTraces[0].result.type, "CALL")
    assert.equal(blockTraces[0].result.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(blockTraces[0].result.output, `0x${"0".repeat(62)}2a`)
  })

  it("debug_trace* supports prestateTracer output", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)
    const slotZero = `0x${"0".repeat(64)}`

    const txPrestate = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "prestateTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Record<string, {
      code?: string
      balance?: string
      nonce?: string
      storage?: Record<string, string>
    }>
    assert.equal(txPrestate[FUNDED_ADDRESS.toLowerCase()].nonce, "0x1")
    assert.equal(txPrestate[contractAddress.toLowerCase()].code, RUNTIME_CODE)
    assert.equal(txPrestate[contractAddress.toLowerCase()].storage?.[slotZero], "0x2a")

    const txPrestateSlim = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "prestateTracer", tracerConfig: { disableCode: true, disableStorage: true } }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Record<string, {
      code?: string
      nonce?: string
      storage?: Record<string, string>
    }>
    assert.equal(txPrestateSlim[FUNDED_ADDRESS.toLowerCase()].nonce, "0x1")
    assert.equal(txPrestateSlim[contractAddress.toLowerCase()].code, undefined)
    assert.equal(txPrestateSlim[contractAddress.toLowerCase()].storage, undefined)

    const txDiff = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      pre: Record<string, { nonce?: string }>
      post: Record<string, { nonce?: string }>
    }
    assert.equal(txDiff.pre[FUNDED_ADDRESS.toLowerCase()].nonce, "0x1")
    assert.equal(txDiff.post[FUNDED_ADDRESS.toLowerCase()].nonce, "0x2")

    const txDiffSlim = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "prestateTracer", tracerConfig: { diffMode: true, disableCode: true, disableStorage: true } }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      pre: Record<string, { code?: string; storage?: Record<string, string> }>
      post: Record<string, { code?: string; storage?: Record<string, string> }>
    }
    assert.equal(txDiffSlim.pre[FUNDED_ADDRESS.toLowerCase()].code, undefined)
    assert.equal(txDiffSlim.post[FUNDED_ADDRESS.toLowerCase()].storage, undefined)

    const callPrestate = await rpc.handleRpcMethod(
      "debug_traceCall",
      [{ from: FUNDED_ADDRESS, to: contractAddress, data: "0x" }, "latest", { tracer: "prestateTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Record<string, {
      nonce?: string
      storage?: Record<string, string>
    }>
    assert.equal(callPrestate[FUNDED_ADDRESS.toLowerCase()].nonce, "0x2")
    assert.equal(callPrestate[contractAddress.toLowerCase()].storage?.[slotZero], "0x2a")

    const blockPrestate = await rpc.handleRpcMethod(
      "debug_traceBlockByNumber",
      ["0x2", { tracer: "prestateTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      txHash: string
      result: Record<string, {
        storage?: Record<string, string>
      }>
    }>
    assert.equal(blockPrestate.length, 1)
    assert.equal(blockPrestate[0].txHash, callTxHash)
    assert.equal(blockPrestate[0].result[contractAddress.toLowerCase()].storage?.[slotZero], "0x2a")
  })

  it("trace_filter supports address filtering and pagination", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const firstCallTxHash = await callStorageContract(engine, contractAddress)
    const secondRawTx = await buildStorageContractCallTx(contractAddress, 2)
    await engine.addRawTx(secondRawTx)
    await engine.proposeNextBlock()
    const secondCallTxHash = Transaction.from(secondRawTx).hash as Hex

    const firstPage = await rpc.handleRpcMethod(
      "trace_filter",
      [{
        fromBlock: "0x2",
        toBlock: "0x3",
        fromAddress: [FUNDED_ADDRESS],
        toAddress: [contractAddress],
        after: 0,
        count: 1,
      }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      transactionHash: string
      blockNumber: string
      transactionPosition: string
      type: string
      action: { from: string; to: string }
      traceAddress: number[]
      result?: { output: string }
    }>
    assert.equal(firstPage.length, 1)
    assert.equal(firstPage[0].transactionHash, firstCallTxHash)
    assert.equal(firstPage[0].blockNumber, "0x2")
    assert.equal(firstPage[0].transactionPosition, "0x0")
    assert.equal(firstPage[0].type, "call")
    assert.equal(firstPage[0].action.from.toLowerCase(), FUNDED_ADDRESS.toLowerCase())
    assert.equal(firstPage[0].action.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(firstPage[0].traceAddress.length, 0)
    assert.equal(firstPage[0].result?.output, `0x${"0".repeat(62)}2a`)

    const secondPage = await rpc.handleRpcMethod(
      "trace_filter",
      [{
        fromBlock: "0x2",
        toBlock: "0x3",
        fromAddress: [FUNDED_ADDRESS],
        toAddress: [contractAddress],
        after: 1,
        count: 1,
      }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      transactionHash: string
      blockNumber: string
      action: { to: string }
    }>
    assert.equal(secondPage.length, 1)
    assert.equal(secondPage[0].transactionHash, secondCallTxHash)
    assert.equal(secondPage[0].blockNumber, "0x3")
    assert.equal(secondPage[0].action.to.toLowerCase(), contractAddress.toLowerCase())
  })

  it("trace_get returns a localized trace for the requested traceAddress", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)

    const rootTrace = await rpc.handleRpcMethod(
      "trace_get",
      [callTxHash, []],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      transactionHash: string
      blockNumber: string
      transactionPosition: string
      type: string
      traceAddress: number[]
      action: { to: string }
      result?: { output: string }
    }
    assert.ok(rootTrace)
    assert.equal(rootTrace.transactionHash, callTxHash)
    assert.equal(rootTrace.blockNumber, "0x2")
    assert.equal(rootTrace.transactionPosition, "0x0")
    assert.equal(rootTrace.type, "call")
    assert.deepEqual(rootTrace.traceAddress, [])
    assert.equal(rootTrace.action.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(rootTrace.result?.output, `0x${"0".repeat(62)}2a`)

    const missingChildTrace = await rpc.handleRpcMethod(
      "trace_get",
      [callTxHash, [0]],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    assert.equal(missingChildTrace, null)
  })

  it("trace_callMany applies earlier simulated calls before later ones", async () => {
    const recipient = "0x00000000000000000000000000000000000000aa"

    const replay = await rpc.handleRpcMethod(
      "trace_callMany",
      [[
        [{ from: FUNDED_ADDRESS, to: recipient, value: "0x1" }, ["trace", "stateDiff"]],
        [{ from: FUNDED_ADDRESS, to: recipient, value: "0x1" }, ["trace", "stateDiff"]],
      ], "latest"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      trace: Array<{
        type: string
        action: { to: string; value: string }
      }>
      stateDiff: Record<string, {
        balance?: Record<string, unknown>
      }>
    }>

    assert.equal(replay.length, 2)
    assert.equal(replay[0].trace[0].type, "call")
    assert.equal(replay[0].trace[0].action.to.toLowerCase(), recipient.toLowerCase())
    assert.equal(replay[0].trace[0].action.value, "0x1")
    assert.deepEqual(replay[0].stateDiff[recipient.toLowerCase()].balance, {
      "+": "0x1",
    })
    assert.deepEqual(replay[1].stateDiff[recipient.toLowerCase()].balance, {
      "*": { from: "0x1", to: "0x2" },
    })
  })

  it("trace_replayTransaction exposes created contract code and storage diffs", async () => {
    const { contractAddress, deployTxHash } = await deployStorageContract(engine)
    const slotZero = `0x${"0".repeat(64)}`

    const deployReplay = await rpc.handleRpcMethod(
      "trace_replayTransaction",
      [deployTxHash, ["stateDiff"]],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      stateDiff: Record<string, {
        code?: Record<string, unknown>
        storage?: Record<string, unknown>
      }>
    }

    assert.deepEqual(deployReplay.stateDiff[contractAddress.toLowerCase()].code, {
      "+": RUNTIME_CODE,
    })
    assert.deepEqual(
      deployReplay.stateDiff[contractAddress.toLowerCase()].storage?.[slotZero],
      { "+": "0x2a" },
    )
  })

  it("trace_replayTransaction and trace_replayBlockTransactions return OpenEthereum-style replay payloads", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)

    const replayTx = await rpc.handleRpcMethod(
      "trace_replayTransaction",
      [callTxHash, ["trace", "stateDiff", "vmTrace"]],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      output: string
      stateDiff: Record<string, {
        balance?: Record<string, unknown>
        nonce?: Record<string, unknown>
        code?: Record<string, unknown>
        storage?: Record<string, unknown>
      }>
      vmTrace: { code: string | null; ops: Array<{ op: string }> }
      trace: Array<{
        type: string
        traceAddress: number[]
        subtraces: number
        result?: { output: string }
      }>
    }
    assert.equal(replayTx.output, `0x${"0".repeat(62)}2a`)
    assert.ok(replayTx.stateDiff[FUNDED_ADDRESS.toLowerCase()])
    assert.deepEqual(replayTx.stateDiff[FUNDED_ADDRESS.toLowerCase()].nonce, {
      "*": { from: "0x1", to: "0x2" },
    })
    assert.equal(replayTx.vmTrace.code, RUNTIME_CODE)
    assert.ok(replayTx.vmTrace.ops.some((step) => step.op === "SLOAD"))
    assert.ok(replayTx.trace.length > 0)
    assert.equal(replayTx.trace[0].type, "call")
    assert.equal(replayTx.trace[0].traceAddress.length, 0)
    assert.equal(replayTx.trace[0].subtraces, 0)
    assert.equal(replayTx.trace[0].result?.output, `0x${"0".repeat(62)}2a`)

    const replayBlock = await rpc.handleRpcMethod(
      "trace_replayBlockTransactions",
      ["0x2", ["trace"]],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      output: string
      trace: Array<{
        type: string
        traceAddress: number[]
        result?: { output: string }
      }>
    }>
    assert.equal(replayBlock.length, 1)
    assert.equal(replayBlock[0].output, `0x${"0".repeat(62)}2a`)
    assert.equal(replayBlock[0].trace[0].type, "call")
    assert.equal(replayBlock[0].trace[0].traceAddress.length, 0)
    assert.equal(replayBlock[0].trace[0].result?.output, `0x${"0".repeat(62)}2a`)
  })

  it("trace_rawTransaction and trace_block expose additional parity methods", async () => {
    const { contractAddress } = await deployStorageContract(engine)
    const callTxHash = await callStorageContract(engine, contractAddress)
    const hypotheticalRawTx = await buildStorageContractCallTx(contractAddress, 2)

    const rawReplay = await rpc.handleRpcMethod(
      "trace_rawTransaction",
      [hypotheticalRawTx, ["trace", "vmTrace", "stateDiff"]],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      output: string
      trace: Array<{
        type: string
        result?: { output: string }
      }>
      vmTrace: { code: string | null; ops: Array<{ op: string }> }
      stateDiff: Record<string, {
        nonce?: Record<string, unknown>
      }>
    }
    assert.equal(rawReplay.output, `0x${"0".repeat(62)}2a`)
    assert.ok(rawReplay.trace.length > 0)
    assert.equal(rawReplay.trace[0].type, "call")
    assert.equal(rawReplay.trace[0].result?.output, `0x${"0".repeat(62)}2a`)
    assert.equal(rawReplay.vmTrace.code, RUNTIME_CODE)
    assert.ok(rawReplay.vmTrace.ops.some((step) => step.op === "SLOAD"))
    assert.deepEqual(rawReplay.stateDiff[FUNDED_ADDRESS.toLowerCase()].nonce, {
      "*": { from: "0x2", to: "0x3" },
    })

    const blockTrace = await rpc.handleRpcMethod(
      "trace_block",
      ["0x2"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Array<{
      blockNumber: string
      transactionHash: string
      transactionPosition: string
      type: string
      traceAddress: number[]
      result?: { output: string }
    }>
    assert.equal(blockTrace.length, 1)
    assert.equal(blockTrace[0].blockNumber, "0x2")
    assert.equal(blockTrace[0].transactionHash, callTxHash)
    assert.equal(blockTrace[0].transactionPosition, "0x0")
    assert.equal(blockTrace[0].type, "call")
    assert.equal(blockTrace[0].traceAddress.length, 0)
    assert.equal(blockTrace[0].result?.output, `0x${"0".repeat(62)}2a`)
  })

  it("callTracer and vmTrace capture nested calls", async () => {
    const artifacts = await compileNestedCallArtifacts()
    const { contractAddress: calleeAddress } = await deployContract(engine, artifacts.callee.bytecode as Hex, 0)
    const { contractAddress: callerAddress } = await deployContract(engine, artifacts.caller.bytecode as Hex, 1)
    const callerInterface = new Interface(artifacts.caller.abi)
    const callTxHash = await callContract(
      engine,
      callerAddress,
      callerInterface.encodeFunctionData("callPing", [calleeAddress]) as Hex,
      2,
    )

    const nestedCallTrace = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "callTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      type: string
      to: string
      output: string
      calls?: Array<{
        type: string
        to: string
        output: string
      }>
    }
    assert.equal(nestedCallTrace.type, "CALL")
    assert.equal(nestedCallTrace.to.toLowerCase(), callerAddress.toLowerCase())
    assert.equal(nestedCallTrace.output, `0x${"0".repeat(62)}2a`)
    assert.equal(nestedCallTrace.calls?.length, 1)
    assert.equal(nestedCallTrace.calls?.[0].type, "CALL")
    assert.equal(nestedCallTrace.calls?.[0].to.toLowerCase(), calleeAddress.toLowerCase())
    assert.equal(nestedCallTrace.calls?.[0].output, `0x${"0".repeat(62)}2a`)

    const nestedCallWithLogs = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "callTracer", tracerConfig: { withLog: true } }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      calls?: Array<{
        to: string
        logs?: Array<{
          address: string
          topics: string[]
          data: string
        }>
      }>
    }
    assert.equal(nestedCallWithLogs.calls?.[0].to.toLowerCase(), calleeAddress.toLowerCase())
    assert.equal(nestedCallWithLogs.calls?.[0].logs?.length, 1)
    assert.equal(nestedCallWithLogs.calls?.[0].logs?.[0].address.toLowerCase(), calleeAddress.toLowerCase())
    assert.ok((nestedCallWithLogs.calls?.[0].logs?.[0].topics.length ?? 0) > 0)

    const topOnlyTrace = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: true } }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      type: string
      calls?: Array<unknown>
    }
    assert.equal(topOnlyTrace.type, "CALL")
    assert.equal(topOnlyTrace.calls, undefined)

    const replay = await rpc.handleRpcMethod(
      "trace_replayTransaction",
      [callTxHash, ["vmTrace"]],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      vmTrace: {
        code: string | null
        ops: Array<{
          sub: null | {
            code: string | null
            ops: Array<{ op: string }>
          }
        }>
      }
    }
    assert.equal(replay.vmTrace.code, artifacts.caller.runtimeCode)
    const nestedVmOp = replay.vmTrace.ops.find((step) => step.sub !== null)
    assert.ok(nestedVmOp)
    assert.equal(nestedVmOp?.sub?.code, artifacts.callee.runtimeCode)
    assert.ok(nestedVmOp?.sub?.ops.some((step) => step.op === "RETURN"))
  })

  it("callTracer exposes revertReason for nested reverts", async () => {
    const artifacts = await compileNestedCallArtifacts()
    const { contractAddress: calleeAddress } = await deployContract(engine, artifacts.callee.bytecode as Hex, 0)
    const { contractAddress: callerAddress } = await deployContract(engine, artifacts.caller.bytecode as Hex, 1)
    const callerInterface = new Interface(artifacts.caller.abi)
    const callTxHash = await callContract(
      engine,
      callerAddress,
      callerInterface.encodeFunctionData("callFail", [calleeAddress]) as Hex,
      2,
    )

    const revertedTrace = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "callTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      error?: string
      revertReason?: string
      calls?: Array<{
        error?: string
        revertReason?: string
      }>
    }

    assert.ok(revertedTrace.error)
    assert.equal(revertedTrace.revertReason, "nested nope")
    assert.equal(revertedTrace.calls?.length, 1)
    assert.ok(revertedTrace.calls?.[0].error)
    assert.equal(revertedTrace.calls?.[0].revertReason, "nested nope")
  })

  it("callTracer exposes custom error selectors for nested reverts", async () => {
    const artifacts = await compileNestedCallArtifacts()
    const { contractAddress: calleeAddress } = await deployContract(engine, artifacts.callee.bytecode as Hex, 0)
    const { contractAddress: callerAddress } = await deployContract(engine, artifacts.caller.bytecode as Hex, 1)
    const callerInterface = new Interface(artifacts.caller.abi)
    const calleeInterface = new Interface(artifacts.callee.abi)
    const expectedSelector = calleeInterface.getError("NestedCustom").selector
    const callTxHash = await callContract(
      engine,
      callerAddress,
      callerInterface.encodeFunctionData("callFailCustom", [calleeAddress]) as Hex,
      2,
    )

    const revertedTrace = await rpc.handleRpcMethod(
      "debug_traceTransaction",
      [callTxHash, { tracer: "callTracer" }],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      revertReason?: string
      calls?: Array<{
        revertReason?: string
      }>
    }

    assert.equal(revertedTrace.revertReason, `CustomError(${expectedSelector})`)
    assert.equal(revertedTrace.calls?.[0].revertReason, `CustomError(${expectedSelector})`)
  })
})
