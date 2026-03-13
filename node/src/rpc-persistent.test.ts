/**
 * RPC integration tests with persistent storage backend
 *
 * Verifies that RPC methods work correctly when backed by
 * PersistentChainEngine and LevelDB storage.
 */

import { test } from "node:test"
import assert from "node:assert"
import http from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wallet, parseEther, Transaction, getCreateAddress } from "ethers"
import { KECCAK256_NULL_S, KECCAK256_RLP_S } from "@ethereumjs/util"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { startRpcServer } from "./rpc.ts"
import { handleRpcMethod } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"
import type { Hex } from "./blockchain-types.ts"
import { LevelDatabase } from "./storage/db.ts"
import { PersistentStateTrie } from "./storage/state-trie.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"

const CHAIN_ID = 2077

interface RpcResponse {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { message: string }
}

async function rpcCall(port: number, method: string, params: unknown[] = []): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve(JSON.parse(data)))
      },
    )
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

async function setupTestEnv(): Promise<{
  port: number
  server: http.Server
  engine: PersistentChainEngine
  evm: EvmChain
  wallet: Wallet
  tmpDir: string
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-persistent-"))
  const evm = await EvmChain.create(CHAIN_ID)
  const wallet = Wallet.createRandom()

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: "node-1",
      chainId: CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      prefundAccounts: [
        { address: wallet.address, balanceWei: parseEther("100").toString() },
      ],
    },
    evm,
  )

  await engine.init()

  const p2p = new P2PNode(
    { bind: "127.0.0.1", port: 0, peers: [] },
    {
      onTx: async () => {},
      onBlock: async () => {},
      onSnapshotRequest: () => ({ blocks: [], updatedAtMs: Date.now() }),
    },
  )

  // Create server with dynamic port
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      if (req.method !== "POST") {
        res.writeHead(405)
        res.end()
        return
      }

      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body)
          // Import handleOne logic inline
          const rpcModule = await import("./rpc.ts")
          // Use startRpcServer indirectly - create a simple proxy
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { message: String(error) } }))
        }
      })
    })

    // Use the real RPC server
    const port = 19700 + Math.floor(Math.random() * 200)
    startRpcServer("127.0.0.1", port, CHAIN_ID, evm, engine, p2p)

    // Wait for server to start
    setTimeout(() => {
      resolve({ port, server, engine, evm, wallet, tmpDir })
    }, 200)
  })
}

test("RPC+Persistent: eth_blockNumber starts at 0", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-p-"))
  const evm = await EvmChain.create(CHAIN_ID)
  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: "node-1",
      chainId: CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  await engine.init()

  const height = await engine.getHeight()
  assert.strictEqual(height, 0n)

  await engine.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

test("RPC+Persistent: propose block and query", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-p-"))

  try {
    const evm = await EvmChain.create(CHAIN_ID)
    const wallet = Wallet.createRandom()

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth: 3,
        maxTxPerBlock: 50,
        minGasPriceWei: 1n,
        prefundAccounts: [
          { address: wallet.address, balanceWei: parseEther("100").toString() },
        ],
      },
      evm,
    )
    await engine.init()

    // Add tx and produce block
    const rawTx = await wallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("1"),
      gasLimit: 21000,
      gasPrice: 1000000000,
      nonce: 0,
      chainId: CHAIN_ID,
    })

    await engine.addRawTx(rawTx as Hex)
    const block = await engine.proposeNextBlock()
    assert.ok(block)
    assert.strictEqual(block.number, 1n)

    // Query block
    const retrieved = await engine.getBlockByNumber(1n)
    assert.ok(retrieved)
    assert.strictEqual(retrieved.hash, block.hash)

    // Query by hash
    const byHash = await engine.getBlockByHash(block.hash)
    assert.ok(byHash)
    assert.strictEqual(byHash.number, 1n)

    // Query tx
    const parsed = Transaction.from(block.txs[0])
    const txResult = await engine.getTransactionByHash(parsed.hash as Hex)
    assert.ok(txResult)
    assert.ok(txResult.receipt)

    // Height
    const height = await engine.getHeight()
    assert.strictEqual(height, 1n)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("RPC+Persistent: log indexing end-to-end", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-p-"))

  try {
    const evm = await EvmChain.create(CHAIN_ID)
    const wallet = Wallet.createRandom()

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth: 3,
        maxTxPerBlock: 50,
        minGasPriceWei: 1n,
        prefundAccounts: [
          { address: wallet.address, balanceWei: parseEther("100").toString() },
        ],
      },
      evm,
    )
    await engine.init()

    // Produce a block with a simple transfer (no logs expected for ETH transfer)
    const rawTx = await wallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("0.1"),
      gasLimit: 21000,
      gasPrice: 1000000000,
      nonce: 0,
      chainId: CHAIN_ID,
    })

    await engine.addRawTx(rawTx as Hex)
    await engine.proposeNextBlock()

    // Query logs for block range
    const logs = await engine.getLogs({ fromBlock: 0n, toBlock: 1n })
    // Simple ETH transfer produces no event logs
    assert.ok(Array.isArray(logs))
    assert.strictEqual(logs.length, 0)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("RPC+Persistent: receipts survive restart", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-p-"))
  const wallet = Wallet.createRandom()
  const prefund = [
    { address: wallet.address, balanceWei: parseEther("100").toString() },
  ]

  try {
    let txHash: string

    // Session 1: produce blocks
    {
      const evm = await EvmChain.create(CHAIN_ID)
      const engine = new PersistentChainEngine(
        {
          dataDir: tmpDir,
          nodeId: "node-1",
          chainId: CHAIN_ID,
          validators: ["node-1"],
          finalityDepth: 3,
          maxTxPerBlock: 50,
          minGasPriceWei: 1n,
          prefundAccounts: prefund,
        },
        evm,
      )
      await engine.init()

      const rawTx = await wallet.signTransaction({
        to: Wallet.createRandom().address,
        value: parseEther("1"),
        gasLimit: 21000,
        gasPrice: 1000000000,
        nonce: 0,
        chainId: CHAIN_ID,
      })

      await engine.addRawTx(rawTx as Hex)
      const block = await engine.proposeNextBlock()
      assert.ok(block)

      const parsed = Transaction.from(block.txs[0])
      txHash = parsed.hash!

      await engine.close()
    }

    // Session 2: verify persistence
    {
      const evm = await EvmChain.create(CHAIN_ID)
      const engine = new PersistentChainEngine(
        {
          dataDir: tmpDir,
          nodeId: "node-1",
          chainId: CHAIN_ID,
          validators: ["node-1"],
          finalityDepth: 3,
          maxTxPerBlock: 50,
          minGasPriceWei: 1n,
          prefundAccounts: prefund,
        },
        evm,
      )
      await engine.init()

      // Block should persist
      const height = await engine.getHeight()
      assert.strictEqual(height, 1n)

      // Transaction receipt should persist
      const tx = await engine.getTransactionByHash(txHash as Hex)
      assert.ok(tx, "Transaction should persist across restarts")
      assert.ok(tx.receipt)
      assert.strictEqual(tx.receipt.blockNumber, 1n)
      assert.strictEqual(tx.receipt.status, 1n)

      await engine.close()
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("RPC+Persistent: multiple blocks with receipts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-p-"))

  try {
    const evm = await EvmChain.create(CHAIN_ID)
    const wallet = Wallet.createRandom()

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth: 3,
        maxTxPerBlock: 50,
        minGasPriceWei: 1n,
        prefundAccounts: [
          { address: wallet.address, balanceWei: parseEther("100").toString() },
        ],
      },
      evm,
    )
    await engine.init()

    // Produce blocks one at a time: add tx, propose, repeat
    const blockCount = 5
    for (let i = 0; i < blockCount; i++) {
      const rawTx = await wallet.signTransaction({
        to: Wallet.createRandom().address,
        value: parseEther("0.1"),
        gasLimit: 21000,
        gasPrice: 1000000000,
        nonce: i,
        chainId: CHAIN_ID,
      })
      await engine.addRawTx(rawTx as Hex)
      await engine.proposeNextBlock()
    }

    // Verify height
    const height = await engine.getHeight()
    assert.ok(height >= 1n, `height should be >= 1, got ${height}`)

    // Verify all produced blocks are queryable
    for (let i = 1n; i <= height; i++) {
      const block = await engine.getBlockByNumber(i)
      assert.ok(block)
      assert.ok(block.txs.length >= 1)
    }

    // Verify receipts for each block
    for (let i = 1n; i <= height; i++) {
      const receipts = await engine.getReceiptsByBlock(i)
      assert.ok(Array.isArray(receipts))
    }

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("RPC+Persistent: historical state queries and transaction schema parity", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-rpc-history-"))
  const wallet = Wallet.createRandom()
  const transferTarget = Wallet.createRandom().address
  const deployerGasPrice = 1_000_000_000n
  const runtimeCode = "0x60005460005260206000f3"
  const initCode = "0x602a600055600b6011600039600b6000f360005460005260206000f3"
  const p2p = { receiveTx: async () => {} } as P2PNode

  let engine: PersistentChainEngine | null = null
  let stateDb: LevelDatabase | null = null

  try {
    stateDb = new LevelDatabase(tmpDir, "state")
    await stateDb.open()
    const stateTrie = new PersistentStateTrie(stateDb)
    await stateTrie.init()
    const stateManager = new PersistentStateManager(stateTrie)
    const evm = await EvmChain.create(CHAIN_ID, stateManager)

    engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
        chainId: CHAIN_ID,
        validators: ["node-1"],
        finalityDepth: 3,
        maxTxPerBlock: 50,
        minGasPriceWei: 1n,
        prefundAccounts: [
          { address: wallet.address, balanceWei: parseEther("100").toString() },
        ],
        stateTrie,
      },
      evm,
    )
    await engine.init()

    const transferTx = await wallet.signTransaction({
      to: transferTarget,
      value: parseEther("1"),
      gasLimit: 21_000,
      gasPrice: deployerGasPrice,
      nonce: 0,
      chainId: CHAIN_ID,
    })
    await engine.addRawTx(transferTx as Hex)
    await engine.proposeNextBlock()

    const deployTx = await wallet.signTransaction({
      data: initCode,
      gasLimit: 200_000,
      gasPrice: deployerGasPrice,
      nonce: 1,
      chainId: CHAIN_ID,
    })
    await engine.addRawTx(deployTx as Hex)
    await engine.proposeNextBlock()

    const block1 = await engine.getBlockByNumber(1n)
    const block2 = await engine.getBlockByNumber(2n)
    assert.ok(block1?.stateRoot)
    assert.ok(block2?.stateRoot)

    const deployTxHash = Transaction.from(deployTx).hash as Hex
    const contractAddress = getCreateAddress({ from: wallet.address, nonce: 1 })

    const balanceAtBlock1 = await handleRpcMethod("eth_getBalance", [wallet.address, "0x1"], CHAIN_ID, evm, engine, p2p)
    const balanceAtBlock2 = await handleRpcMethod("eth_getBalance", [wallet.address, "0x2"], CHAIN_ID, evm, engine, p2p)
    assert.ok(BigInt(balanceAtBlock1 as string) > BigInt(balanceAtBlock2 as string))

    const nonceAtBlock1 = await handleRpcMethod("eth_getTransactionCount", [wallet.address, "0x1"], CHAIN_ID, evm, engine, p2p)
    const nonceAtBlock2 = await handleRpcMethod("eth_getTransactionCount", [wallet.address, "0x2"], CHAIN_ID, evm, engine, p2p)
    assert.strictEqual(nonceAtBlock1, "0x1")
    assert.strictEqual(nonceAtBlock2, "0x2")

    const codeAtBlock1 = await handleRpcMethod("eth_getCode", [contractAddress, "0x1"], CHAIN_ID, evm, engine, p2p)
    const codeAtBlock2 = await handleRpcMethod("eth_getCode", [contractAddress, "0x2"], CHAIN_ID, evm, engine, p2p)
    assert.strictEqual(codeAtBlock1, "0x")
    assert.strictEqual(codeAtBlock2, runtimeCode)

    const storageAtBlock1 = await handleRpcMethod(
      "eth_getStorageAt",
      [contractAddress, "0x0", "0x1"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    const storageAtBlock2 = await handleRpcMethod(
      "eth_getStorageAt",
      [contractAddress, "0x0", "0x2"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    assert.strictEqual(storageAtBlock1, `0x${"0".repeat(64)}`)
    assert.strictEqual(storageAtBlock2, `0x${"0".repeat(62)}2a`)

    const callAtBlock1 = await handleRpcMethod(
      "eth_call",
      [{ to: contractAddress, data: "0x" }, "0x1"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    const callAtBlock2 = await handleRpcMethod(
      "eth_call",
      [{ to: contractAddress, data: "0x" }, "0x2"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    assert.strictEqual(callAtBlock1, "0x")
    assert.strictEqual(callAtBlock2, `0x${"0".repeat(62)}2a`)

    const estimateAtBlock1 = await handleRpcMethod(
      "eth_estimateGas",
      [{ from: wallet.address, to: contractAddress, data: "0x" }, "0x1"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    const estimateAtBlock2 = await handleRpcMethod(
      "eth_estimateGas",
      [{ from: wallet.address, to: contractAddress, data: "0x" }, "0x2"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    )
    assert.strictEqual(estimateAtBlock1, "0x5a3c")
    assert.ok(BigInt(String(estimateAtBlock2)) > 0x5208n)

    const accessListView = await handleRpcMethod(
      "eth_createAccessList",
      [{ from: wallet.address, to: contractAddress, data: "0x" }, "0x2"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as { accessList: Array<{ address: string; storageKeys: string[] }>; gasUsed: string }
    assert.ok(accessListView.accessList.length > 0)
    const contractAccess = accessListView.accessList.find((entry) => entry.address.toLowerCase() === contractAddress.toLowerCase())
    assert.ok(contractAccess)
    assert.ok(contractAccess!.storageKeys.includes(`0x${"0".repeat(64)}`))
    assert.match(accessListView.gasUsed, /^0x[0-9a-f]+$/)

    const proofBeforeDeploy = await handleRpcMethod(
      "eth_getProof",
      [contractAddress, [`0x${"0".repeat(64)}`], "0x1"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      address: string
      balance: string
      codeHash: string
      nonce: string
      storageHash: string
      accountProof: string[]
      storageProof: Array<{ key: string; value: string; proof: string[] }>
    }
    assert.strictEqual(proofBeforeDeploy.address.toLowerCase(), contractAddress.toLowerCase())
    assert.strictEqual(proofBeforeDeploy.balance, "0x0")
    assert.strictEqual(proofBeforeDeploy.nonce, "0x0")
    assert.strictEqual(proofBeforeDeploy.codeHash, KECCAK256_NULL_S)
    assert.strictEqual(proofBeforeDeploy.storageHash, KECCAK256_RLP_S)
    assert.ok(proofBeforeDeploy.accountProof.length > 0)
    assert.strictEqual(proofBeforeDeploy.storageProof.length, 1)
    assert.strictEqual(proofBeforeDeploy.storageProof[0].value, "0x0")

    const proofAfterDeploy = await handleRpcMethod(
      "eth_getProof",
      [contractAddress, [`0x${"0".repeat(64)}`], "0x2"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as {
      address: string
      balance: string
      codeHash: string
      nonce: string
      storageHash: string
      accountProof: string[]
      storageProof: Array<{ key: string; value: string; proof: string[] }>
    }
    assert.strictEqual(proofAfterDeploy.address.toLowerCase(), contractAddress.toLowerCase())
    assert.strictEqual(proofAfterDeploy.balance, "0x0")
    assert.strictEqual(proofAfterDeploy.nonce, "0x1")
    assert.match(proofAfterDeploy.codeHash, /^0x[0-9a-f]{64}$/)
    assert.match(proofAfterDeploy.storageHash, /^0x[0-9a-f]{64}$/)
    assert.ok(proofAfterDeploy.accountProof.length > 0)
    assert.strictEqual(proofAfterDeploy.storageProof.length, 1)
    assert.strictEqual(proofAfterDeploy.storageProof[0].key, `0x${"0".repeat(64)}`)
    assert.strictEqual(proofAfterDeploy.storageProof[0].value, "0x2a")
    assert.ok(proofAfterDeploy.storageProof[0].proof.length > 0)

    const txView = await handleRpcMethod("eth_getTransactionByHash", [deployTxHash], CHAIN_ID, evm, engine, p2p) as Record<string, unknown>
    assert.strictEqual(txView.hash, deployTxHash)
    assert.strictEqual(txView.blockNumber, "0x2")
    assert.strictEqual(txView.blockHash, block2.hash)
    assert.strictEqual(txView.transactionIndex, "0x0")
    assert.strictEqual(txView.nonce, "0x1")
    assert.strictEqual(txView.gas, "0x30d40")
    assert.strictEqual(txView.gasPrice, "0x3b9aca00")
    assert.strictEqual(txView.input, initCode)
    assert.strictEqual(txView.type, "0x1")
    assert.strictEqual(txView.chainId, `0x${CHAIN_ID.toString(16)}`)

    const txByBlockHash = await handleRpcMethod(
      "eth_getTransactionByBlockHashAndIndex",
      [block2.hash, "0x0"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Record<string, unknown>
    assert.strictEqual(txByBlockHash.hash, deployTxHash)
    assert.strictEqual(txByBlockHash.blockHash, block2.hash)
    assert.strictEqual(txByBlockHash.blockNumber, "0x2")
    assert.strictEqual(txByBlockHash.transactionIndex, "0x0")
    assert.strictEqual(txByBlockHash.nonce, "0x1")
    assert.strictEqual(txByBlockHash.chainId, `0x${CHAIN_ID.toString(16)}`)

    const txByBlockNumber = await handleRpcMethod(
      "eth_getTransactionByBlockNumberAndIndex",
      ["0x2", "0x0"],
      CHAIN_ID,
      evm,
      engine,
      p2p,
    ) as Record<string, unknown>
    assert.strictEqual(txByBlockNumber.hash, deployTxHash)
    assert.strictEqual(txByBlockNumber.blockHash, block2.hash)
    assert.strictEqual(txByBlockNumber.blockNumber, "0x2")
    assert.strictEqual(txByBlockNumber.transactionIndex, "0x0")
    assert.strictEqual(txByBlockNumber.nonce, "0x1")
    assert.strictEqual(txByBlockNumber.chainId, `0x${CHAIN_ID.toString(16)}`)

    const receiptView = await handleRpcMethod("eth_getTransactionReceipt", [deployTxHash], CHAIN_ID, evm, engine, p2p) as Record<string, unknown>
    assert.strictEqual(receiptView.transactionHash, deployTxHash)
    assert.strictEqual(receiptView.blockNumber, "0x2")
    assert.strictEqual(receiptView.blockHash, block2.hash)
    assert.strictEqual(receiptView.transactionIndex, "0x0")
    assert.strictEqual(receiptView.contractAddress, contractAddress)
    assert.strictEqual(receiptView.status, "0x1")
    assert.strictEqual(receiptView.effectiveGasPrice, "0x3b9aca00")
    assert.match(String(receiptView.logsBloom), /^0x[0-9a-f]{512}$/)
    assert.ok(typeof receiptView.cumulativeGasUsed === "string")
    assert.ok(typeof receiptView.gasUsed === "string")
  } finally {
    if (engine) {
      await engine.close()
    }
    if (stateDb) {
      await stateDb.close()
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
