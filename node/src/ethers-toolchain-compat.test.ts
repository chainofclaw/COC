import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContractFactory, Interface, JsonRpcProvider, Wallet, parseEther } from "ethers"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { P2PNode } from "./p2p.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const COUNTER_SOURCE = `
pragma solidity ^0.8.0;

contract Counter {
    uint256 public value;

    function set(uint256 nextValue) external {
        value = nextValue;
    }
}
`

async function compileCounter(): Promise<{ abi: any[]; bytecode: string }> {
  const module = await import("solc")
  const solc = (module.default ?? module) as { compile(input: string): string }
  const input = {
    language: "Solidity",
    sources: {
      "Counter.sol": { content: COUNTER_SOURCE },
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    contracts?: Record<string, Record<string, { abi?: any[]; evm?: { bytecode?: { object?: string } } }>>
    errors?: Array<{ severity?: string; formattedMessage?: string; message?: string }>
  }
  const fatalErrors = (output.errors ?? []).filter((entry) => entry.severity === "error")
  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map((entry) => entry.formattedMessage ?? entry.message ?? "solc error").join("\n"))
  }
  const artifact = output.contracts?.["Counter.sol"]?.Counter
  if (!artifact?.abi || !artifact.evm?.bytecode?.object) {
    throw new Error("counter artifact missing")
  }
  return {
    abi: artifact.abi,
    bytecode: artifact.evm.bytecode.object.startsWith("0x")
      ? artifact.evm.bytecode.object
      : `0x${artifact.evm.bytecode.object}`,
  }
}

test("ethers provider deploys and traces contracts without custom patches", async () => {
  const previousDebugEnv = process.env.COC_DEBUG_RPC
  process.env.COC_DEBUG_RPC = "1"

  const tempDir = await mkdtemp(join(tmpdir(), "coc-ethers-compat-"))
  const evm = await EvmChain.create(CHAIN_ID)
  const engine = new PersistentChainEngine(
    {
      dataDir: tempDir,
      nodeId: "node-1",
      chainId: CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      prefundAccounts: [
        {
          address: new Wallet(FUNDED_PK).address,
          balanceWei: parseEther("100").toString(),
        },
      ],
    },
    evm,
  )
  await engine.init()
  await engine.proposeNextBlock()

  const p2p = new P2PNode(
    { bind: "127.0.0.1", port: 0, peers: [] },
    {
      onTx: async () => {},
      onBlock: async () => {},
      onSnapshotRequest: () => ({ blocks: [], updatedAtMs: Date.now() }),
    },
  )

  const port = 19880 + Math.floor(Math.random() * 200)
  const { startRpcServer } = await import("./rpc.ts")
  const server = startRpcServer("127.0.0.1", port, CHAIN_ID, evm, engine, p2p)
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`)
  const signer = new Wallet(FUNDED_PK, provider)

  try {
    const artifact = await compileCounter()
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer)
    const contract = await factory.deploy()
    await engine.proposeNextBlock()
    await contract.waitForDeployment()
    const contractAddress = await contract.getAddress()

    assert.notEqual(await provider.getCode(contractAddress), "0x")
    assert.equal(await contract.value(), 0n)

    const setTx = await contract.set(7n)
    await engine.proposeNextBlock()
    const setReceipt = await setTx.wait()
    assert.ok(setReceipt)
    assert.equal(setReceipt.status, 1)
    assert.equal(await contract.value(), 7n)

    const counterInterface = new Interface(artifact.abi)
    const accessList = await provider.send("eth_createAccessList", [
      {
        from: signer.address,
        to: contractAddress,
        data: counterInterface.encodeFunctionData("set", [9n]),
      },
      "latest",
    ]) as { accessList: Array<{ address: string; storageKeys: string[] }>; gasUsed: string }
    const contractAccess = accessList.accessList.find((entry) => entry.address.toLowerCase() === contractAddress.toLowerCase())
    assert.ok(contractAccess)
    assert.ok(contractAccess!.storageKeys.length > 0)
    assert.match(accessList.gasUsed, /^0x[0-9a-f]+$/)

    const callTrace = await provider.send("debug_traceTransaction", [
      setReceipt.hash,
      { tracer: "callTracer" },
    ]) as { type: string; to: string; input: string }
    assert.equal(callTrace.type, "CALL")
    assert.equal(callTrace.to.toLowerCase(), contractAddress.toLowerCase())
    assert.equal(
      callTrace.input,
      counterInterface.encodeFunctionData("set", [7n]).toLowerCase(),
    )
  } finally {
    provider.destroy()
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await engine.close()
    await p2p.stop?.()
    await rm(tempDir, { recursive: true, force: true })
    if (previousDebugEnv === undefined) delete process.env.COC_DEBUG_RPC
    else process.env.COC_DEBUG_RPC = previousDebugEnv
  }
})
