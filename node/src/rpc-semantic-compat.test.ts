import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Wallet, Transaction, parseEther } from "ethers"
import { startRpcServer } from "./rpc.ts"
import http from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"
import { PersistentStateTrie } from "./storage/state-trie.ts"
import { MemoryDatabase } from "./storage/db.ts"
import type { P2PNode } from "./p2p.ts"
import type { Hex } from "./blockchain-types.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

async function rpcCall(port: number, method: string, params: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    const req = http.request({ hostname: "127.0.0.1", port, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = ""
      res.on("data", (chunk: string) => { data += chunk })
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed.result)
        } catch (e) { reject(e) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

describe("RPC semantic compatibility: block tags + pending nonce", () => {
  let tmpDir: string
  let evm: EvmChain
  let engine: PersistentChainEngine
  let rpcServer: ReturnType<typeof startRpcServer>
  let rpcPort: number
  const wallet = new Wallet(FUNDED_PK)
  const p2p = { receiveTx: async () => {}, getPeers: () => [], getStats: () => ({}) } as unknown as P2PNode

  async function setup(finalityDepth = 2) {
    tmpDir = await mkdtemp(join(tmpdir(), "rpc-semantic-"))
    evm = await EvmChain.create(CHAIN_ID)
    engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth,
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
  }

  async function teardown() {
    await new Promise<void>((resolve) => {
      (rpcServer as any).close(() => resolve())
    })
    await engine.close()
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  it("eth_getTransactionCount with 'pending' tag returns mempool-aware nonce", async () => {
    await setup()
    try {
      // Submit a tx but do NOT propose a block — tx stays in mempool
      const signedTx = await wallet.signTransaction({
        to: RECIPIENT,
        value: 1n,
        nonce: 0,
        gasLimit: 21000n,
        gasPrice: 1_000_000_000n,
        chainId: CHAIN_ID,
      })
      await engine.addRawTx(signedTx as Hex)

      // "pending" should return 1 (on-chain 0 + 1 pending tx)
      const pendingNonce = await rpcCall(rpcPort, "eth_getTransactionCount", [FUNDED_ADDRESS, "pending"])
      assert.equal(pendingNonce, "0x1", "pending nonce should account for mempool tx")

      // "latest" should return 0 (on-chain nonce, no block mined)
      const latestNonce = await rpcCall(rpcPort, "eth_getTransactionCount", [FUNDED_ADDRESS, "latest"])
      assert.equal(latestNonce, "0x0", "latest nonce should be on-chain value")
    } finally {
      await teardown()
    }
  })

  it("finalized/safe block tags return lower height than latest", async () => {
    await setup(2) // finalityDepth = 2
    try {
      // Produce 5 blocks so finalized = 3
      for (let i = 0; i < 5; i++) {
        const tx = await wallet.signTransaction({
          to: RECIPIENT,
          value: 1n,
          nonce: i,
          gasLimit: 21000n,
          gasPrice: 1_000_000_000n,
          chainId: CHAIN_ID,
        })
        await engine.addRawTx(tx as Hex)
        await engine.proposeNextBlock()
      }

      const latest = await rpcCall(rpcPort, "eth_getBlockByNumber", ["latest", false]) as any
      const finalized = await rpcCall(rpcPort, "eth_getBlockByNumber", ["finalized", false]) as any
      const safe = await rpcCall(rpcPort, "eth_getBlockByNumber", ["safe", false]) as any

      assert.ok(latest, "latest block should exist")
      assert.ok(finalized, "finalized block should exist")
      assert.ok(safe, "safe block should exist")

      const latestNum = BigInt(latest.number)
      const finalizedNum = BigInt(finalized.number)
      const safeNum = BigInt(safe.number)

      assert.equal(latestNum, 5n, "latest should be 5")
      assert.ok(finalizedNum < latestNum, `finalized (${finalizedNum}) should be < latest (${latestNum})`)
      assert.equal(finalizedNum, safeNum, "safe and finalized should be equal for PoSe chain")
      assert.equal(finalizedNum, 3n, "finalized should be tip - finalityDepth = 5 - 2 = 3")
    } finally {
      await teardown()
    }
  })

  it("eth_getBlockByNumber('earliest') maps to block 0", async () => {
    await setup()
    try {
      // Produce 1 block
      const tx = await wallet.signTransaction({
        to: RECIPIENT, value: 1n, nonce: 0, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
      })
      await engine.addRawTx(tx as Hex)
      await engine.proposeNextBlock()

      // PersistentChainEngine starts at block 1, no block 0 exists.
      // "earliest" should resolve to block 0, which returns null (no genesis block in persistent engine).
      const earliest = await rpcCall(rpcPort, "eth_getBlockByNumber", ["earliest", false]) as any
      assert.equal(earliest, null, "earliest (block 0) returns null when chain starts at block 1")

      // Verify block 1 exists
      const block1 = await rpcCall(rpcPort, "eth_getBlockByNumber", ["0x1", false]) as any
      assert.ok(block1, "block 1 should exist")
      assert.equal(BigInt(block1.number), 1n, "block 1 should have number 1")
    } finally {
      await teardown()
    }
  })

  it("eth_getTransactionByHash finds pending mempool tx", async () => {
    await setup()
    try {
      const signedTx = await wallet.signTransaction({
        to: RECIPIENT, value: 1n, nonce: 0, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
      })
      const result = await engine.addRawTx(signedTx as Hex)
      const txHash = result.hash

      // Should find the pending tx
      const tx = await rpcCall(rpcPort, "eth_getTransactionByHash", [txHash]) as any
      assert.ok(tx, "should find pending tx in mempool")
      assert.equal(tx.blockHash, null, "pending tx should have null blockHash")
      assert.equal(tx.blockNumber, null, "pending tx should have null blockNumber")
    } finally {
      await teardown()
    }
  })

  it("finalized returns block 0 (clamped) when chain height < finalityDepth", async () => {
    await setup(5) // finalityDepth = 5
    try {
      // Only produce 2 blocks — finalized = max(0, 2 - 5) = 0
      for (let i = 0; i < 2; i++) {
        const tx = await wallet.signTransaction({
          to: RECIPIENT, value: 1n, nonce: i, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
        })
        await engine.addRawTx(tx as Hex)
        await engine.proposeNextBlock()
      }

      // Finalized height resolves to 0 when height < finalityDepth.
      // Block 0 does not exist in PersistentChainEngine (starts at block 1), so returns null.
      const finalized = await rpcCall(rpcPort, "eth_getBlockByNumber", ["finalized", false]) as any
      assert.equal(finalized, null, "finalized should return null when clamped to block 0 (no genesis)")

      // With enough blocks, finalized should return a real block
      for (let i = 2; i < 7; i++) {
        const tx = await wallet.signTransaction({
          to: RECIPIENT, value: 1n, nonce: i, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
        })
        await engine.addRawTx(tx as Hex)
        await engine.proposeNextBlock()
      }

      // Now height = 7, finalized = 7 - 5 = 2
      const finalizedAfter = await rpcCall(rpcPort, "eth_getBlockByNumber", ["finalized", false]) as any
      assert.ok(finalizedAfter, "finalized block should exist after enough blocks")
      assert.equal(BigInt(finalizedAfter.number), 2n, "finalized should be height - finalityDepth = 7 - 5 = 2")
    } finally {
      await teardown()
    }
  })

  it("formatBlock includes Cancun stub fields", async () => {
    await setup()
    try {
      const tx = await wallet.signTransaction({
        to: RECIPIENT, value: 1n, nonce: 0, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
      })
      await engine.addRawTx(tx as Hex)
      await engine.proposeNextBlock()

      const block = await rpcCall(rpcPort, "eth_getBlockByNumber", ["0x1", false]) as any
      assert.ok(block)
      assert.equal(block.blobGasUsed, "0x0", "block should have blobGasUsed")
      assert.equal(block.excessBlobGas, "0x0", "block should have excessBlobGas")
      assert.ok("parentBeaconBlockRoot" in block, "block should have parentBeaconBlockRoot")
    } finally {
      await teardown()
    }
  })

  it("eth_getBalance with 'finalized' tag returns balance at finalized block, not latest", async () => {
    // This test requires persistent state trie to support historical state queries
    tmpDir = await mkdtemp(join(tmpdir(), "rpc-semantic-state-"))
    const stateDb = new MemoryDatabase()
    const stateTrie = new PersistentStateTrie(stateDb)
    const stateManager = new PersistentStateManager(stateTrie)
    evm = await EvmChain.create(CHAIN_ID, stateManager)
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
        stateTrie,
      },
      evm,
    )
    await engine.init()
    rpcPort = 38700 + Math.floor(Math.random() * 1000)
    rpcServer = startRpcServer("127.0.0.1", rpcPort, CHAIN_ID, evm, engine, p2p)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Block 1: send 1 ETH to RECIPIENT
      const tx1 = await wallet.signTransaction({
        to: RECIPIENT, value: parseEther("1"), nonce: 0, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
      })
      await engine.addRawTx(tx1 as Hex)
      await engine.proposeNextBlock()

      // Block 2: send another 5 ETH to RECIPIENT
      const tx2 = await wallet.signTransaction({
        to: RECIPIENT, value: parseEther("5"), nonce: 1, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
      })
      await engine.addRawTx(tx2 as Hex)
      await engine.proposeNextBlock()

      // Block 3: send another 3 ETH to RECIPIENT
      const tx3 = await wallet.signTransaction({
        to: RECIPIENT, value: parseEther("3"), nonce: 2, gasLimit: 21000n, gasPrice: 1_000_000_000n, chainId: CHAIN_ID,
      })
      await engine.addRawTx(tx3 as Hex)
      await engine.proposeNextBlock()

      // height=3, finalityDepth=2, finalized=block 1
      // finalized balance = 1 ETH (only block 1 transfer)
      // latest balance = 1 + 5 + 3 = 9 ETH
      const finalizedBalance = BigInt(await rpcCall(rpcPort, "eth_getBalance", [RECIPIENT, "finalized"]) as string)
      const latestBalance = BigInt(await rpcCall(rpcPort, "eth_getBalance", [RECIPIENT, "latest"]) as string)

      assert.equal(finalizedBalance, parseEther("1"), "finalized balance should be exactly 1 ETH (block 1 only)")
      assert.equal(latestBalance, parseEther("9"), "latest balance should be 9 ETH (all 3 blocks)")
      assert.ok(finalizedBalance < latestBalance, "finalized balance must be strictly less than latest")
    } finally {
      await teardown()
    }
  })
})
