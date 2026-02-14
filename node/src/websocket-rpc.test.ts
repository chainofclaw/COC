/**
 * WebSocket RPC server tests
 *
 * Tests eth_subscribe/eth_unsubscribe for:
 * - newHeads subscription
 * - newPendingTransactions subscription
 * - logs subscription with filtering
 * - Standard RPC method forwarding over WebSocket
 * - Client disconnect cleanup
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { Hex } from "./blockchain-types.ts"
import { WsRpcServer } from "./websocket-rpc.ts"
import { Wallet, parseEther, Transaction } from "ethers"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const CHAIN_ID = 18780
const WS_PORT = 19999
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

function createSignedTx(nonce: number, to: string, valueWei: bigint): Hex {
  const wallet = new Wallet(FUNDED_PK)
  const tx = Transaction.from({
    to,
    value: `0x${valueWei.toString(16)}`,
    nonce,
    gasLimit: "0x5208",
    gasPrice: "0x3b9aca00",
    chainId: CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const signedTx = tx.clone()
  signedTx.signature = signed
  return signedTx.serialized as Hex
}

// Minimal P2P stub
const stubP2P = {
  receiveTx: async () => {},
  start: () => {},
  bind: "127.0.0.1",
  port: 0,
  peers: [],
  onTx: async () => {},
  onBlock: async () => {},
  onSnapshotRequest: () => ({ blocks: [], updatedAtMs: 0 }),
} as any

async function sendRpc(ws: WebSocket, method: string, params: unknown[] = []): Promise<unknown> {
  const id = Math.floor(Math.random() * 100000)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), 5000)

    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) {
        ws.removeListener("message", handler)
        clearTimeout(timeout)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    }
    ws.on("message", handler)
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs)
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString())
      // Only capture subscription notifications
      if (msg.method === "eth_subscription") {
        ws.removeListener("message", handler)
        clearTimeout(timeout)
        resolve(msg)
      }
    }
    ws.on("message", handler)
  })
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on("open", () => resolve(ws))
    ws.on("error", reject)
  })
}

describe("WebSocket RPC", () => {
  let tmpDir: string
  let evm: EvmChain
  let chain: IChainEngine
  let server: WsRpcServer

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ws-rpc-test-"))
    evm = await EvmChain.create(CHAIN_ID)

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node-1",
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
    chain = engine

    // Simple RPC handler that delegates to chain methods
    const handleRpcMethod = async (
      method: string,
      params: unknown[],
    ): Promise<unknown> => {
      switch (method) {
        case "eth_blockNumber": {
          const height = await Promise.resolve(chain.getHeight())
          return `0x${height.toString(16)}`
        }
        case "eth_chainId":
          return `0x${CHAIN_ID.toString(16)}`
        default:
          throw new Error(`method not supported: ${method}`)
      }
    }

    server = new WsRpcServer(
      { port: WS_PORT, bind: "127.0.0.1" },
      CHAIN_ID,
      evm,
      chain,
      stubP2P,
      chain.events,
      handleRpcMethod as any,
    )
    server.start()

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  afterEach(async () => {
    server.stop()
    const closeable = chain as PersistentChainEngine
    if (typeof closeable.close === "function") {
      await closeable.close()
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    // Small delay for port release
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  it("standard RPC methods work over WebSocket", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      const chainId = await sendRpc(ws, "eth_chainId")
      assert.equal(chainId, `0x${CHAIN_ID.toString(16)}`)

      const blockNum = await sendRpc(ws, "eth_blockNumber")
      assert.equal(blockNum, "0x0")
    } finally {
      ws.close()
    }
  })

  it("newHeads subscription receives block notifications", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      // Subscribe to newHeads
      const subId = await sendRpc(ws, "eth_subscribe", ["newHeads"])
      assert.ok(typeof subId === "string")
      assert.ok(subId.startsWith("0x"))

      // Set up message listener before producing block
      const msgPromise = waitForMessage(ws)

      // Produce a block
      const rawTx = createSignedTx(0, "0x0000000000000000000000000000000000000001", 1000n)
      await chain.addRawTx(rawTx)
      await chain.proposeNextBlock()

      // Wait for subscription notification
      const msg = await msgPromise
      assert.equal(msg.method, "eth_subscription")
      const msgParams = msg.params as Record<string, unknown>
      assert.equal(msgParams.subscription, subId)
      const result = msgParams.result as Record<string, unknown>
      assert.ok(result.number)
      assert.ok(result.hash)
      assert.ok(result.parentHash)

      // Unsubscribe
      const unsubResult = await sendRpc(ws, "eth_unsubscribe", [subId])
      assert.equal(unsubResult, true)
    } finally {
      ws.close()
    }
  })

  it("newPendingTransactions subscription receives tx hashes", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      const subId = await sendRpc(ws, "eth_subscribe", ["newPendingTransactions"])
      assert.ok(typeof subId === "string")

      const msgPromise = waitForMessage(ws)

      const rawTx = createSignedTx(0, "0x0000000000000000000000000000000000000001", 1000n)
      await chain.addRawTx(rawTx)

      const msg = await msgPromise
      assert.equal(msg.method, "eth_subscription")
      const msgParams = msg.params as Record<string, unknown>
      assert.equal(msgParams.subscription, subId)
      // Result should be a tx hash
      assert.ok(typeof msgParams.result === "string")
      assert.ok((msgParams.result as string).startsWith("0x"))
    } finally {
      ws.close()
    }
  })

  it("unsubscribe stops notifications", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      const subId = await sendRpc(ws, "eth_subscribe", ["newHeads"])
      const unsubResult = await sendRpc(ws, "eth_unsubscribe", [subId])
      assert.equal(unsubResult, true)

      // Produce a block - should NOT receive notification
      const rawTx = createSignedTx(0, "0x0000000000000000000000000000000000000001", 1000n)
      await chain.addRawTx(rawTx)
      await chain.proposeNextBlock()

      // Wait briefly and check if any subscription message arrives
      let received = false
      const handler = (data: Buffer | string) => {
        const msg = JSON.parse(data.toString())
        if (msg.method === "eth_subscription") {
          received = true
        }
      }
      ws.on("message", handler)
      await new Promise((resolve) => setTimeout(resolve, 500))
      ws.removeListener("message", handler)

      assert.equal(received, false, "should not receive notification after unsubscribe")
    } finally {
      ws.close()
    }
  })

  it("client disconnect cleans up subscriptions", async () => {
    const ws = await connectWs(WS_PORT)
    await sendRpc(ws, "eth_subscribe", ["newHeads"])

    assert.equal(server.getClientCount(), 1)

    ws.close()
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(server.getClientCount(), 0)
  })
})
