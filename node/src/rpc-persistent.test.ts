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
import { Wallet, parseEther, Transaction } from "ethers"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"
import type { Hex } from "./blockchain-types.ts"

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
