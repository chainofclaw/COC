import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEther, Wallet, Transaction } from "ethers"
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  encodeFunctionData,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { startRpcServer } from "./rpc.ts"
import type { P2PNode } from "./p2p.ts"
import type { Hex } from "./blockchain-types.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

const cocChain = defineChain({
  id: CHAIN_ID,
  name: "COC Local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:0"] } },
})

describe("P11: viem toolchain compatibility", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine
  let rpcServer: ReturnType<typeof startRpcServer>
  let rpcPort: number
  const p2p = { receiveTx: async () => {}, getPeers: () => [], getStats: () => ({}) } as unknown as P2PNode

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "viem-compat-"))
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

    rpcPort = 38700 + Math.floor(Math.random() * 1000)
    rpcServer = startRpcServer("127.0.0.1", rpcPort, CHAIN_ID, evm, engine, p2p)
    await new Promise((r) => setTimeout(r, 150))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      (rpcServer as any).close(() => resolve())
    })
    await engine.close()
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  function getPublicClient() {
    return createPublicClient({
      chain: { ...cocChain, rpcUrls: { default: { http: [`http://127.0.0.1:${rpcPort}`] } } },
      transport: http(`http://127.0.0.1:${rpcPort}`),
    })
  }

  it("createPublicClient + getBlock", async () => {
    // Propose a block so we have height >= 1
    await engine.proposeNextBlock()
    const client = getPublicClient()
    const block = await client.getBlock({ blockNumber: 1n })
    assert.ok(block)
    assert.equal(block.number, 1n)
    assert.ok(block.hash)
    assert.ok("mixHash" in block)
    assert.ok("withdrawals" in block)
  })

  it("getBalance returns funded account balance", async () => {
    const client = getPublicClient()
    const balance = await client.getBalance({ address: FUNDED_ADDRESS as `0x${string}` })
    assert.ok(balance > 0n, "funded account should have balance")
  })

  it("estimateGas returns gas estimate", async () => {
    const client = getPublicClient()
    const gas = await client.estimateGas({
      account: FUNDED_ADDRESS as `0x${string}`,
      to: "0x" + "bb".repeat(20) as `0x${string}`,
      value: 1n,
    })
    assert.ok(gas > 0n)
    assert.ok(gas >= 21000n)
  })

  it("getFeeHistory returns valid fee data", async () => {
    const client = getPublicClient()
    // Need at least 1 block for fee history
    const wallet = new Wallet(FUNDED_PK)
    const signedTx = await wallet.signTransaction({
      to: "0x" + "bb".repeat(20),
      value: 1n,
      nonce: 0,
      gasLimit: 21000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 500_000_000n,
      chainId: CHAIN_ID,
      type: 2,
    })
    await engine.addRawTx(signedTx as Hex)
    await engine.proposeNextBlock()

    const feeHistory = await client.getFeeHistory({
      blockCount: 1,
      rewardPercentiles: [25, 50, 75],
    })
    assert.ok(feeHistory)
    assert.ok(feeHistory.baseFeePerGas.length > 0)
    assert.ok(feeHistory.gasUsedRatio.length > 0)
    assert.ok(feeHistory.reward)
    assert.ok(feeHistory.reward!.length > 0)
  })

  it("deployContract and readContract (Counter pattern)", async () => {
    // Deploy a simple storage contract using ethers (since viem deploy needs more setup)
    // Storage contract: stores 42 in slot 0 and returns it
    const INIT_CODE = "0x602a600055600b6011600039600b6000f360005460005260206000f3"
    const wallet = new Wallet(FUNDED_PK)
    const deployTx = await wallet.signTransaction({
      data: INIT_CODE,
      gasLimit: 200_000,
      gasPrice: 1_000_000_000n,
      nonce: 0,
      chainId: CHAIN_ID,
    })
    await engine.addRawTx(deployTx as Hex)
    await engine.proposeNextBlock()

    const { getCreateAddress } = await import("ethers")
    const contractAddress = getCreateAddress({ from: wallet.address, nonce: 0 })

    const client = getPublicClient()

    // Read contract via eth_call
    const result = await client.call({
      to: contractAddress as `0x${string}`,
      data: "0x" as `0x${string}`,
    })
    assert.ok(result.data)
    // Value should be 42 (0x2a)
    assert.ok(result.data!.endsWith("2a"))
  })

  it("getBlock includes Shanghai-compliant fields", async () => {
    await engine.proposeNextBlock()
    const client = getPublicClient()
    const block = await client.getBlock({ blockNumber: 1n })
    assert.ok("withdrawals" in block)
    assert.ok("withdrawalsRoot" in block)
    assert.deepEqual(block.withdrawals, [])
  })

  it("getChainId returns correct chain ID", async () => {
    const client = getPublicClient()
    const chainId = await client.getChainId()
    assert.equal(chainId, CHAIN_ID)
  })

  it("getBlockNumber returns current height", async () => {
    // Add a tx and propose to guarantee block 1
    const wallet = new Wallet(FUNDED_PK)
    const tx = await wallet.signTransaction({
      to: "0x" + "cc".repeat(20),
      value: 1n,
      nonce: 0,
      gasLimit: 21000n,
      gasPrice: 1_000_000_000n,
      chainId: CHAIN_ID,
    })
    await engine.addRawTx(tx as Hex)
    await engine.proposeNextBlock()

    // Create a fresh client (no cache)
    const client = getPublicClient()
    const blockNumber = await client.getBlockNumber()
    assert.ok(blockNumber >= 1n, "block number should be at least 1 after propose")
  })
})
