import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wallet, getCreateAddress, parseEther } from "ethers"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { startRpcServer } from "./rpc.ts"
import type { P2PNode } from "./p2p.ts"
import type { Hex } from "./blockchain-types.ts"

const CHAIN_ID = 18780
const CHAIN_ID_HEX = "0x495c"
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const STORAGE_INIT_CODE = "0x602a600055600b6011600039600b6000f360005460005260206000f3"

async function rpcCall(port: number, method: string, params: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk: string) => { data += chunk })
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.error) reject(new Error(parsed.error.message))
            else resolve(parsed.result)
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

describe("Prowl wallet/toolchain RPC compatibility", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine
  let rpcServer: ReturnType<typeof startRpcServer>
  let rpcPort: number
  const wallet = new Wallet(FUNDED_PK)
  const p2p = { receiveTx: async () => {}, getPeers: () => [], getStats: () => ({}) } as unknown as P2PNode

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wallet-compat-"))
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
    rpcPort = 39500 + Math.floor(Math.random() * 1000)
    rpcServer = startRpcServer("127.0.0.1", rpcPort, CHAIN_ID, evm, engine, p2p)
    await new Promise((resolve) => setTimeout(resolve, 150))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      (rpcServer as any).close(() => resolve())
    })
    await engine.close()
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("MetaMask bootstrap RPCs expose stable network and fee data", async () => {
    const tx = await wallet.signTransaction({
      to: RECIPIENT,
      value: 1n,
      nonce: 0,
      gasLimit: 21_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 500_000_000n,
      type: 2,
      chainId: CHAIN_ID,
    })
    await engine.addRawTx(tx as Hex)
    await engine.proposeNextBlock()

    const chainId = await rpcCall(rpcPort, "eth_chainId") as string
    const netVersion = await rpcCall(rpcPort, "net_version") as string
    const blockNumber = await rpcCall(rpcPort, "eth_blockNumber") as string
    const latestBlock = await rpcCall(rpcPort, "eth_getBlockByNumber", ["latest", false]) as Record<string, unknown>
    const maxPriorityFee = await rpcCall(rpcPort, "eth_maxPriorityFeePerGas") as string
    const feeHistory = await rpcCall(rpcPort, "eth_feeHistory", [1, "latest", [25, 50, 75]]) as {
      baseFeePerGas: string[]
      gasUsedRatio: number[]
      reward?: string[][]
    }

    assert.equal(chainId, CHAIN_ID_HEX)
    assert.equal(netVersion, String(CHAIN_ID))
    assert.equal(blockNumber, "0x1")
    assert.equal(latestBlock.number, "0x1")
    assert.match(String(latestBlock.baseFeePerGas), /^0x[0-9a-f]+$/)
    assert.match(String(latestBlock.blobGasUsed), /^0x[0-9a-f]+$/)
    assert.match(String(latestBlock.excessBlobGas), /^0x[0-9a-f]+$/)
    assert.match(String(latestBlock.parentBeaconBlockRoot), /^0x[0-9a-f]{64}$/)
    assert.match(maxPriorityFee, /^0x[0-9a-f]+$/)
    assert.ok(feeHistory.baseFeePerGas.length >= 2)
    assert.equal(feeHistory.gasUsedRatio.length, 1)
    assert.ok(Array.isArray(feeHistory.reward))
  })

  it("MetaMask-style pending send flow sees mempool nonce and pending tx shape", async () => {
    const tx = await wallet.signTransaction({
      to: RECIPIENT,
      value: 1n,
      nonce: 0,
      gasLimit: 21_000n,
      gasPrice: 1_000_000_000n,
      chainId: CHAIN_ID,
    })
    const result = await engine.addRawTx(tx as Hex)

    const pendingNonce = await rpcCall(rpcPort, "eth_getTransactionCount", [FUNDED_ADDRESS, "pending"]) as string
    const pendingTx = await rpcCall(rpcPort, "eth_getTransactionByHash", [result.hash]) as Record<string, unknown>

    assert.equal(pendingNonce, "0x1")
    assert.equal(pendingTx.hash, result.hash)
    assert.equal(pendingTx.blockHash, null)
    assert.equal(pendingTx.blockNumber, null)
    assert.equal(pendingTx.transactionIndex, null)
  })

  it("Foundry-style raw deployment and call workflow works over JSON-RPC", async () => {
    const deployTx = await wallet.signTransaction({
      data: STORAGE_INIT_CODE,
      gasLimit: 200_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 500_000_000n,
      nonce: 0,
      type: 2,
      chainId: CHAIN_ID,
    })
    const txHash = await rpcCall(rpcPort, "eth_sendRawTransaction", [deployTx]) as string
    await engine.proposeNextBlock()

    const contractAddress = getCreateAddress({ from: wallet.address, nonce: 0 })
    const receipt = await rpcCall(rpcPort, "eth_getTransactionReceipt", [txHash]) as Record<string, unknown>
    const code = await rpcCall(rpcPort, "eth_getCode", [contractAddress, "latest"]) as string
    const estimate = await rpcCall(rpcPort, "eth_estimateGas", [{ from: FUNDED_ADDRESS, to: contractAddress, data: "0x" }, "latest"]) as string
    const callResult = await rpcCall(rpcPort, "eth_call", [{ to: contractAddress, data: "0x" }, "latest"]) as string

    assert.equal(receipt.transactionHash, txHash)
    assert.equal(receipt.status, "0x1")
    assert.equal(receipt.contractAddress, contractAddress)
    assert.notEqual(code, "0x")
    assert.ok(BigInt(estimate) > 21_000n)
    assert.ok(callResult.endsWith("2a"), `expected getter to return 42, got ${callResult}`)
  })
})
