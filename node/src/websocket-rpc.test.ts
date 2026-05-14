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
        case "__throw_ethers_shape": {
          // Mirrors ethers' Error shape: { code: string, message includes version }
          // Pre-#214 the WS path forwarded this verbatim — code as string
          // violated §5.1, and the version=X.Y leaked the ethers internal.
          throw { code: "BUFFER_OVERRUN", message: "data short segment too short (buffer=0xabcd, length=2, offset=44, code=BUFFER_OVERRUN, version=6.16.0)" }
        }
        case "__throw_non_string_message": {
          // Edge case: message is an object — pre-fix this also leaked
          // an object as the JSON-RPC error message.
          throw { code: -32602, message: { weird: "shape" } }
        }
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
      assert.match(result.transactionsRoot as string, /^0x[0-9a-f]{64}$/)
      assert.match(result.receiptsRoot as string, /^0x[0-9a-f]{64}$/)
      assert.match(result.logsBloom as string, /^0x[0-9a-f]{512}$/)

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

  // #130: structured JSON-RPC error helper — sendRpc rejects with just
  // the message, losing the code. This variant returns the full error.
  async function sendRpcExpectError(ws: WebSocket, method: string, params: unknown[] = []): Promise<{ code: number; message: string }> {
    const id = Math.floor(Math.random() * 100000)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5000)
      const handler = (data: Buffer | string) => {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) {
          ws.removeListener("message", handler)
          clearTimeout(timeout)
          if (msg.error) resolve(msg.error)
          else reject(new Error(`expected error but got result: ${JSON.stringify(msg.result)}`))
        }
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }

  it("#130: eth_subscribe with bogus type returns -32602 (not -32603)", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      const err = await sendRpcExpectError(ws, "eth_subscribe", ["bogusType"])
      assert.equal(err.code, -32602, `expected -32602 invalid params, got ${err.code} (${err.message})`)
      assert.match(err.message, /unsupported subscription type/)
    } finally {
      ws.close()
    }
  })

  it("#130: eth_subscribe with no params returns -32602", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      const err = await sendRpcExpectError(ws, "eth_subscribe", [])
      assert.equal(err.code, -32602, `expected -32602 invalid params, got ${err.code}`)
    } finally {
      ws.close()
    }
  })

  it("#244: eth_subscribe('logs', non-object) returns -32602 (no silent no-filter)", async () => {
    // Pre-fix `(params[1] ?? {}) as Record<string, unknown>` was a
    // TS-only runtime no-op. eth_subscribe("logs", true) etc. fell
    // through to validateLogFilter which read only undefined fields
    // and returned an empty filter — silent "match ALL logs"
    // subscription, leaking subscription handles to bad clients.
    // Same anti-pattern as #238 (HTTP-side sibling).
    const ws = await connectWs(WS_PORT)
    try {
      for (const bad of [true, false, "string", 42, [1, 2]]) {
        const err = await sendRpcExpectError(ws, "eth_subscribe", ["logs", bad])
        assert.equal(err.code, -32602,
          `eth_subscribe("logs", ${JSON.stringify(bad)}) must be -32602, got ${err.code} (${err.message})`)
        assert.match(err.message, /invalid filter|expected object/i)
      }
      // Sanity: omitted filter or empty object still creates a valid
      // subscription (default range, match all — by design).
      const sub1 = await sendRpc(ws, "eth_subscribe", ["logs"])
      assert.match(sub1, /^0x[0-9a-f]+$/, `omitted filter must create subscription, got ${sub1}`)
      const sub2 = await sendRpc(ws, "eth_subscribe", ["logs", {}])
      assert.match(sub2, /^0x[0-9a-f]+$/, `empty-object filter must create subscription, got ${sub2}`)
    } finally {
      ws.close()
    }
  })

  it("#274: eth_subscribe('logs', filter) validates fromBlock / toBlock / blockHash / inner-topic-cap with -32602", async () => {
    // Pre-fix the LOCAL `validateLogFilter` in websocket-rpc.ts didn't
    // validate fromBlock/toBlock/blockHash at all, threw `new Error(...)`
    // (-32603 internal-error) instead of `invalidParams` (-32602), and
    // had an inner OR-topic cap of 100 versus HTTP's 32 (after #266).
    // This test asserts WS now matches HTTP — single source of truth.
    const ws = await connectWs(WS_PORT)
    try {
      // fromBlock: negative number / negative string / non-string-non-number → -32602
      for (const bad of [-1, "-1", true, {}, [1]]) {
        const err = await sendRpcExpectError(ws, "eth_subscribe", ["logs", { fromBlock: bad }])
        assert.equal(err.code, -32602,
          `fromBlock=${JSON.stringify(bad)} must be -32602, got ${err.code} (${err.message})`)
      }
      // toBlock: same
      for (const bad of [-1, "-1", true, {}, [1]]) {
        const err = await sendRpcExpectError(ws, "eth_subscribe", ["logs", { toBlock: bad }])
        assert.equal(err.code, -32602,
          `toBlock=${JSON.stringify(bad)} must be -32602, got ${err.code} (${err.message})`)
      }
      // blockHash: anything that isn't a 32-byte hex string → -32602
      for (const bad of ["not-hex", "0xshort", 123, true, {}, [1]]) {
        const err = await sendRpcExpectError(ws, "eth_subscribe", ["logs", { blockHash: bad }])
        assert.equal(err.code, -32602,
          `blockHash=${JSON.stringify(bad)} must be -32602, got ${err.code} (${err.message})`)
      }
      // address: shape-rejected → -32602 (was -32603 pre-fix)
      const addrErr = await sendRpcExpectError(ws, "eth_subscribe", ["logs", { address: "not-an-address" }])
      assert.equal(addrErr.code, -32602,
        `malformed address must be -32602, got ${addrErr.code} (${addrErr.message})`)
      // Topics: 5 outer → -32602 (was -32603)
      const tooManyTopicsErr = await sendRpcExpectError(ws, "eth_subscribe",
        ["logs", { topics: [null, null, null, null, null] }])
      assert.equal(tooManyTopicsErr.code, -32602,
        `5 outer topics must be -32602, got ${tooManyTopicsErr.code} (${tooManyTopicsErr.message})`)
      // #519: wording parity with HTTP `eth_getLogs` (rpc-validators.ts
      // line 638). Pre-fix WS emitted "topics array must have at most 4
      // elements" while HTTP emitted "topics array too large: 5 > 4 (max
      // indexed log topics)". Clients pattern-matching the error string had
      // to handle both forms. Lock the wording to the HTTP variant since
      // its message is geth-canonical and rpc-validators.test.ts:779 already
      // asserts against it.
      assert.match(tooManyTopicsErr.message, /^topics array too large: 5 > 4/,
        `WS topic-too-many wording must match HTTP eth_getLogs (rpc-validators.ts:638), got "${tooManyTopicsErr.message}"`)
      // Symmetric: non-array topics must also match HTTP wording.
      const nonArrayTopicsErr = await sendRpcExpectError(ws, "eth_subscribe",
        ["logs", { topics: "not-an-array" }])
      assert.equal(nonArrayTopicsErr.code, -32602,
        `non-array topics must be -32602, got ${nonArrayTopicsErr.code}`)
      assert.match(nonArrayTopicsErr.message, /^invalid filter topics:/,
        `WS non-array topics wording must match HTTP wording, got "${nonArrayTopicsErr.message}"`)
      // Inner topic OR-array: 33+ → -32602 (matches HTTP cap from #266)
      const inner33 = Array.from({ length: 33 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`)
      const innerCapErr = await sendRpcExpectError(ws, "eth_subscribe",
        ["logs", { topics: [inner33] }])
      assert.equal(innerCapErr.code, -32602,
        `inner OR-array of 33 must be -32602, got ${innerCapErr.code} (${innerCapErr.message})`)
      // Sanity: well-shaped filters still create subscriptions
      const okHash = `0x${"ab".repeat(32)}`
      const okAddr = `0x${"cd".repeat(20)}`
      const okTopic = `0x${"ef".repeat(32)}`
      const sub1 = await sendRpc(ws, "eth_subscribe",
        ["logs", { fromBlock: "0x1", toBlock: "0x100", blockHash: okHash, address: okAddr, topics: [okTopic] }])
      assert.match(sub1, /^0x[0-9a-f]+$/, `well-shaped filter must create subscription, got ${sub1}`)
    } finally {
      ws.close()
    }
  })

  it("#130: 11th subscription on one client returns -32005 (not -32603)", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      // MAX_SUBSCRIPTIONS_PER_CLIENT = 10 — fill the cap with newHeads.
      for (let i = 0; i < 10; i++) {
        await sendRpc(ws, "eth_subscribe", ["newHeads"])
      }
      const err = await sendRpcExpectError(ws, "eth_subscribe", ["newHeads"])
      assert.equal(err.code, -32005, `expected -32005 resource limit, got ${err.code} (${err.message})`)
      assert.match(err.message, /max subscriptions per client/)
    } finally {
      ws.close()
    }
  })

  it("#144: WS notification (no id) gets no response (JSON-RPC §4.1)", async () => {
    const ws = await connectWs(WS_PORT)
    try {
      // Send a notification — no id field. Wait briefly to confirm no
      // message arrives. Pre-fix the server replied with {id:null,result}.
      let received: unknown = null
      const handler = (data: Buffer | string) => {
        received = JSON.parse(data.toString())
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [] }))
      // Give the server 500ms to (incorrectly) respond.
      await new Promise((resolve) => setTimeout(resolve, 500))
      ws.removeListener("message", handler)
      assert.equal(received, null, `WS server must NOT respond to notification, got: ${JSON.stringify(received)}`)

      // Sanity: a normal request after the notification still works.
      const result = await sendRpc(ws, "eth_chainId")
      assert.equal(result, `0x${CHAIN_ID.toString(16)}`, "subsequent request must still work")
    } finally {
      ws.close()
    }
  })

  it("#206: WS envelope rejects non-conforming jsonrpc/id/method/params (HTTP parity)", async () => {
    // Parity with HTTP RPC #202/#204. Pre-fix WS only checked
    // `!payload.method`, so jsonrpc!="2.0", id as object/array/bool,
    // method as 0/empty, and params as string/bool/number all flowed
    // through to dispatch — a strict-client inter-op hazard.
    const ws = await connectWs(WS_PORT)
    try {
      // Helper: send a one-shot, get the next message back.
      const probe = (body: Record<string, unknown>): Promise<{ error?: { code: number; message: string }; result?: unknown }> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("probe timeout")), 2000)
          const handler = (data: Buffer | string) => {
            clearTimeout(timer)
            ws.removeListener("message", handler)
            try { resolve(JSON.parse(data.toString())) } catch (e) { reject(e) }
          }
          ws.on("message", handler)
          ws.send(JSON.stringify(body))
        })
      // jsonrpc must be exactly "2.0"
      for (const v of ["1.0", "1.1", "", 2]) {
        const r = await probe({ jsonrpc: v, id: 1, method: "eth_chainId" })
        assert.equal(r.error?.code, -32600, `jsonrpc=${JSON.stringify(v)} must be -32600, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /jsonrpc/i, "error must name the field")
      }
      // id must be string|number|null
      for (const badId of [{ obj: 1 }, [1, 2], true, false]) {
        const r = await probe({ jsonrpc: "2.0", id: badId, method: "eth_chainId" })
        assert.equal(r.error?.code, -32600, `id=${JSON.stringify(badId)} must be -32600, got ${JSON.stringify(r)}`)
      }
      // method must be non-empty string
      for (const m of [0, "", null, true]) {
        const r = await probe({ jsonrpc: "2.0", id: 1, method: m })
        assert.equal(r.error?.code, -32600, `method=${JSON.stringify(m)} must be -32600, got ${JSON.stringify(r)}`)
      }
      // params must be Array|Object|undefined|null
      for (const p of ["not-array", 42, true]) {
        const r = await probe({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: p })
        assert.equal(r.error?.code, -32600, `params=${JSON.stringify(p)} must be -32600, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /params must be/i, "error must name params")
      }
      // Sanity: well-formed request still works.
      const ok = await probe({ jsonrpc: "2.0", id: 1, method: "eth_chainId" })
      assert.equal(ok.error, undefined, "well-formed envelope must NOT error")
      assert.ok(typeof ok.result === "string", "result must be returned")

      // #318: WS-RPC parity with HTTP #314/#316 — method length cap +
      // string id length cap + control-char rejection. Pre-fix the WS
      // envelope inherited the same amplification + log-injection
      // surfaces as HTTP had before #314/#316: a client could send a
      // 5000-char method or id and get it echoed in the response.
      {
        const longMethod = "A".repeat(129)
        const r = await probe({ jsonrpc: "2.0", id: 1, method: longMethod })
        assert.equal(r.error?.code, -32600, "WS method >128 chars must be -32600")
        assert.match(r.error!.message, /too long/i, "WS error must explain length cap")
        assert.ok(!JSON.stringify(r).includes("AAAA"),
          "WS method-too-long error must NOT echo the input")
      }
      {
        const longId = "Z".repeat(257)
        const r = await probe({ jsonrpc: "2.0", id: longId, method: "eth_chainId" })
        assert.equal(r.error?.code, -32600, "WS id >256 chars must be -32600")
        assert.match(r.error!.message, /id too long/i, "WS error must name the field")
        assert.ok(!JSON.stringify(r).includes("ZZZZZ"),
          "WS id-too-long error must NOT echo the input")
      }
      // Control chars in id — same family as #312 (pubsub topic) / #316 (HTTP id)
      for (const bad of ["line1\nline2", "with\rCR", "tab\there", "null\u0000byte", "del\u007fhere"]) {
        const r = await probe({ jsonrpc: "2.0", id: bad, method: "eth_chainId" })
        assert.equal(r.error?.code, -32600, `WS id with control char must be -32600 (id=${JSON.stringify(bad)})`)
        assert.match(r.error!.message, /control character/i, "error must explain control-char rule")
        const serialized = JSON.stringify(r)
        for (const ch of bad) {
          const code = ch.charCodeAt(0)
          if (code < 0x20 || code === 0x7f) {
            assert.ok(!serialized.includes(ch),
              `WS response must not contain raw control char U+${code.toString(16).padStart(4, "0")} from id`)
          }
        }
      }
      // Boundary: exactly-at-cap inputs pass the envelope check. The
      // test stub uses a generic Error in its default branch so unknown
      // methods surface as -32603 here (vs -32601 in prod), but either
      // way the request is dispatched, not blocked by the envelope.
      const okMax = await probe({ jsonrpc: "2.0", id: 1, method: "z".repeat(128) })
      assert.ok(okMax.error && (okMax.error.code === -32601 || okMax.error.code === -32603),
        `WS method of exactly 128 chars must reach dispatch (any non-envelope code), got ${JSON.stringify(okMax)}`)
      assert.doesNotMatch(okMax.error!.message, /too long/i,
        "exactly 128 chars must NOT be rejected by the length cap")
      const okMaxId = await probe({ jsonrpc: "2.0", id: "y".repeat(256), method: "eth_chainId" })
      assert.equal(okMaxId.error, undefined, "WS id of exactly 256 chars must be accepted")
    } finally {
      ws.close()
    }
  })

  it("#208: eth_subscribe/eth_unsubscribe reject malformed params (no silent String() coercion)", async () => {
    // Pre-fix `String(params[0] ?? "")` silently coerced any input.
    // For subscribe: `[["newHeads"]]` joined the single-element array
    // to "newHeads" and got a working subscription with the wrong
    // shape; `[42]`/`[null]` got confusing "unsupported type: null"
    // messages echoing the coerced string. For unsubscribe: any
    // non-matching coercion silently returned false, indistinguishable
    // from "subscription already removed."
    const ws = await connectWs(WS_PORT)
    try {
      const sendAndWait = (method: string, params: unknown[]): Promise<{ error?: { code: number; message: string }; result?: unknown }> =>
        new Promise((resolve, reject) => {
          const id = Math.floor(Math.random() * 1e9)
          const timer = setTimeout(() => reject(new Error("probe timeout")), 2000)
          const handler = (data: Buffer | string) => {
            const msg = JSON.parse(data.toString())
            if (msg.id === id) {
              clearTimeout(timer)
              ws.removeListener("message", handler)
              resolve(msg)
            }
          }
          ws.on("message", handler)
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        })
      // eth_subscribe: non-string subscription type must be -32602.
      for (const p of [42, null, true, ["newHeads"], { type: "newHeads" }]) {
        const r = await sendAndWait("eth_subscribe", [p])
        assert.equal(r.error?.code, -32602, `eth_subscribe([${JSON.stringify(p)}]) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /subscription type/i, "error must name the field")
      }
      // eth_unsubscribe: malformed subscription id must be -32602.
      for (const p of [42, null, true, "not-a-sub-id", "0x123", ["0x" + "a".repeat(32)]]) {
        const r = await sendAndWait("eth_unsubscribe", [p])
        assert.equal(r.error?.code, -32602, `eth_unsubscribe([${JSON.stringify(p)}]) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /subscription id/i, "error must name the field")
      }
      // Sanity: well-formed subscribe + unsubscribe round-trips.
      const subId = await sendRpc(ws, "eth_subscribe", ["newHeads"])
      assert.match(subId as string, /^0x[0-9a-fA-F]{32}$/, "subId must be shape-correct")
      const unsubResult = await sendRpc(ws, "eth_unsubscribe", [subId as string])
      assert.equal(unsubResult, true, "valid subscribe → unsubscribe must return true")
    } finally {
      ws.close()
    }
  })

  it("#214: WS error path normalizes ethers shape errors (HTTP parity)", async () => {
    // Pre-fix the WS error path forwarded structured RPC errors
    // verbatim. ethers throws `{ code: "BUFFER_OVERRUN", message: "...
    // version=6.16.0, ..." }` — the string code violates JSON-RPC §5.1
    // (code MUST be Integer) and the message leaks the library version.
    // The HTTP path was fixed in earlier passes; WS now matches.
    const ws = await connectWs(WS_PORT)
    try {
      const probe = (method: string): Promise<{ error?: { code: unknown; message: unknown }; result?: unknown }> =>
        new Promise((resolve, reject) => {
          const id = Math.floor(Math.random() * 1e9)
          const timer = setTimeout(() => reject(new Error("probe timeout")), 2000)
          const handler = (data: Buffer | string) => {
            const msg = JSON.parse(data.toString())
            if (msg.id === id) {
              clearTimeout(timer)
              ws.removeListener("message", handler)
              resolve(msg)
            }
          }
          ws.on("message", handler)
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method }))
        })
      // Ethers-shape error → must be coerced to -32603 + clean message.
      const r1 = await probe("__throw_ethers_shape")
      assert.equal(typeof r1.error?.code, "number", "code must be numeric")
      assert.equal(r1.error!.code, -32603, `string code must be coerced to -32603, got ${r1.error?.code}`)
      // Message is preserved verbatim by design (it may contain useful
      // domain info for the caller); the ethers version string still
      // leaks at this layer. The deeper fix is upstream sanitization
      // (e.g., #156 / #182 for HTTP). This test pins the code-type
      // contract.
      assert.equal(typeof r1.error!.message, "string", "message must be string")
      // Non-string message → must be replaced with "internal error".
      const r2 = await probe("__throw_non_string_message")
      assert.equal(typeof r2.error?.message, "string", "non-string message must be coerced")
      assert.equal(r2.error!.message, "internal error", "non-string message must become 'internal error'")
    } finally {
      ws.close()
    }
  })
})
