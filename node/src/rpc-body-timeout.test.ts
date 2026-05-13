import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import type http from "node:http"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"

// #346: RPC body reader had no read timeout — slowloris-style attacker
// sending `Content-Length: 100` headers + 0 body bytes tied up a request
// slot until Node's default 5-minute requestTimeout. This suite verifies
// the new 30s body-read timeout kills the connection.

async function startTestRpc(): Promise<{ port: number; close: () => Promise<void> }> {
  const chainId = 18780
  const evm = await EvmChain.create(chainId)
  const dataDir = "/tmp/coc-rpc-body-timeout-" + Date.now() + "-" + Math.random().toString(36).slice(2)
  const chain = new ChainEngine(
    { dataDir, nodeId: "n1", validators: ["n1"], finalityDepth: 3, maxTxPerBlock: 50, minGasPriceWei: 1n },
    evm,
  )
  const p2p = {
    receiveTx: async () => {},
    getStats: () => ({
      rateLimitedRequests: 0,
      authAcceptedRequests: 0,
      authMissingRequests: 0,
      authInvalidRequests: 0,
      authRejectedRequests: 0,
      authNonceTrackerSize: 0,
      inboundAuthMode: "enforce",
      discoveryPendingPeers: 0,
      discoveryIdentityFailures: 0,
    }),
    getPeers: () => [],
  } as unknown as P2PNode
  const port = 19700 + Math.floor(Math.random() * 200)
  const server: http.Server = startRpcServer("127.0.0.1", port, chainId, evm, chain, p2p)
  await new Promise((r) => setTimeout(r, 50))
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

test("#346: RPC body read timeout kills slow client within bounded window", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc()
  t.after(async () => { await close() })

  // To verify the 30s timeout fires without waiting 30s in CI, we monkey-
  // patch the timeout to 200ms via a separate fixture would be ideal — but
  // the constant is module-level. Instead, verify the END-TO-END behaviour:
  // a normal short request completes well within the timeout, and a
  // socket-level partial request gets closed on the server side within a
  // few seconds (verifies the destroy() path) and not hung forever.

  // 1) Normal POST completes fine (regression guard — timeout doesn't
  //    interfere with legitimate traffic).
  const ok = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  })
  const okJson = await ok.json() as { result?: string }
  assert.ok(okJson.result, "normal request must succeed")

  // 2) Slowloris: send headers but no body. The server-side timer must
  //    destroy the socket so we receive ECONNRESET / FIN, not hang.
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1")
    const start = Date.now()
    let socketClosed = false
    socket.on("connect", () => {
      // Send headers with Content-Length: 1000 but 0 body bytes
      socket.write(
        "POST / HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 1000\r\n" +
        "\r\n"
      )
    })
    socket.on("close", () => {
      socketClosed = true
      const elapsed = Date.now() - start
      // The 30s production timeout is too long for CI; we test the
      // POSITIVE invariant (does not hang past 60s) and trust the
      // timeout-firing branch via code review + the destroy() side effect.
      // For the unit assertion we hard-cap our patience at 45s; if the
      // server-side timer is broken, the destroy() never happens and we
      // hit our own 45s watchdog below.
      assert.ok(elapsed < 45_000, `socket must close within 45s; got ${elapsed}ms`)
      resolve()
    })
    socket.on("error", () => {
      socketClosed = true
      resolve()
    })
    // Fail-safe watchdog so the test itself doesn't hang past 45s.
    setTimeout(() => {
      if (!socketClosed) {
        socket.destroy()
        reject(new Error("server failed to close slowloris socket within 45s"))
      }
    }, 45_000).unref()
  })
})
