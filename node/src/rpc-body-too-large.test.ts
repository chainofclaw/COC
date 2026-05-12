import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"

/**
 * #360 regression: the RPC body-size guard in `rpc.ts:317` called
 * `req.destroy()` inline right after `res.end(...)`. When the client
 * was mid-stream uploading a body larger than MAX_RPC_BODY (1 MiB),
 * the response was still buffered in the Node http stream — the
 * destroy raced ahead and sent TCP RST before the response made it
 * to the wire. Clients saw "Connection reset by peer" / ECONNRESET
 * instead of the documented `413 + { code: -32600, message: "request
 * body too large" }`.
 *
 * Live testnet 88780 reproduction at N=27000-29000 addresses (~1.13
 * MiB body) — 3 of 5 attempts crashed the socket; the rest returned
 * the graceful 413.
 *
 * Fix uses the `res.end(body, cb)` flush callback so `req.socket
 * ?.destroy()` runs only after the response is on the wire, and
 * adds `Connection: close` so the client doesn't try to reuse
 * the (about-to-be-destroyed) socket for keep-alive.
 */
test("#360: oversized RPC body returns a clean 413 (no mid-response RST)", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"

  const chainId = 18780
  const dataDir = `/tmp/coc-rpc-360-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const evm = await EvmChain.create(chainId)
  const chain = new ChainEngine(
    {
      dataDir,
      nodeId: "node-1",
      validators: ["node-1"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
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

  const port = 19790 + Math.floor(Math.random() * 100)
  const server = startRpcServer("127.0.0.1", port, chainId, evm, chain, p2p)
  t.after(() => {
    server.close()
  })

  // Wait for listen
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  // Craft a body that, after the first few chunks, exceeds MAX_RPC_BODY (1 MiB).
  // Pre-fix this triggered the destroy-races-res.end window.
  const bodySize = 2 * 1024 * 1024 // 2 MiB — well past the 1 MiB cap
  const chunkSize = 64 * 1024     // 64 KiB chunks (typical TCP write granularity)
  const chunk = Buffer.alloc(chunkSize, 0x61) // 'a'
  const expectedChunks = bodySize / chunkSize

  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port })
    let received = Buffer.alloc(0)
    let resetSeen = false
    let respondedBeforeReset = false

    sock.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
        resetSeen = true
        // Decide based on whether we already buffered the response.
        if (!respondedBeforeReset) reject(new Error("ECONNRESET fired before any response bytes — pre-fix bug shape"))
      } else {
        reject(err)
      }
    })

    sock.on("data", (buf) => {
      received = Buffer.concat([received, buf])
      // Once we've buffered the status line + headers + body, mark it.
      if (received.includes("\r\n\r\n")) respondedBeforeReset = true
    })

    sock.on("close", () => {
      try {
        const text = received.toString("utf8")
        assert.match(text, /^HTTP\/1\.1 413/, `expected 413 status line, got:\n${text.slice(0, 200)}`)
        assert.match(text, /request body too large/, "expected JSON-RPC error message in body")
        assert.match(text, /"code":-32600/, "expected JSON-RPC -32600 code in body")
        assert.match(text.toLowerCase(), /connection: close/, "expected Connection: close header so the client doesn't reuse the about-to-die socket")
        resolve()
      } catch (e) {
        reject(e)
      }
    })

    sock.on("connect", async () => {
      // Send request line + headers indicating a body twice the limit.
      sock.write(
        "POST / HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${bodySize}\r\n` +
          "\r\n",
      )
      // Stream the body in chunks with a tiny gap between writes so the
      // server's `data` handler enters multiple times and triggers the
      // mid-stream abort path. Without this pacing Node may coalesce
      // chunks before the handler ever sees them and bypass the race.
      for (let i = 0; i < expectedChunks; i++) {
        if (sock.destroyed) break
        sock.write(chunk)
        await new Promise((r) => setImmediate(r))
      }
    })
  })
})
