/**
 * #376 regression: non-POST requests to the JSON-RPC HTTP server must
 * return 405 with explicit `Content-Length: 0` so HEAD requests
 * terminate immediately instead of hanging until the keep-alive
 * timeout fires.
 *
 * Pre-fix `res.writeHead(405); res.end()` defaulted to chunked
 * Transfer-Encoding. For HEAD requests, Node suppresses the body but
 * still advertises chunked — the client (curl, every LB health
 * probe) then waits for a terminating chunk that never arrives,
 * hanging until the 5 s keepAliveTimeout fires.
 *
 * Live testnet 88780 reproduction (pre-fix):
 *
 *   $ time curl -X HEAD http://node:28780
 *   → 6.47 s  (5 s keep-alive + RTT)
 *
 * Fix sets `Content-Length: 0` + `Allow: POST, OPTIONS` (RFC 7231
 * §6.5.5) on the 405 so HEAD / GET / PUT / DELETE all terminate
 * immediately.
 */

import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"

test("#376: HEAD request to RPC returns 405 with Content-Length: 0 (no hang)", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"

  const chainId = 18780
  const dataDir = `/tmp/coc-rpc-376-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
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

  const port = 19890 + Math.floor(Math.random() * 100)
  const server = startRpcServer("127.0.0.1", port, chainId, evm, chain, p2p)
  t.after(() => { server.close() })
  await new Promise<void>((r) => setTimeout(r, 50))

  // Probe HEAD — must return 405 with Content-Length: 0 and Allow header,
  // and the request must complete in well under 5 s (the keep-alive
  // timeout). Pre-fix this would hang for ~5 s waiting for a chunked
  // terminator that Node had suppressed for HEAD.
  const start = Date.now()
  const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, method: "HEAD", path: "/" },
        (res) => {
          res.on("data", () => {})
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
        },
      )
      req.on("error", reject)
      req.setTimeout(3000, () => { req.destroy(new Error("HEAD hang — pre-fix bug shape")); reject(new Error("HEAD hang — pre-fix bug shape")) })
      req.end()
    },
  )
  const elapsed = Date.now() - start

  assert.equal(result.status, 405, "HEAD must return 405 Method Not Allowed")
  assert.equal(result.headers["content-length"], "0", "Content-Length must be 0 (no body to wait for)")
  assert.match(
    String(result.headers["allow"] ?? ""),
    /POST/i,
    "RFC 7231 §6.5.5: 405 must include Allow header listing supported methods",
  )
  assert.ok(elapsed < 1000, `HEAD must terminate quickly (got ${elapsed} ms — pre-fix hung ~5 s on keep-alive timeout)`)

  // GET also rejected with 405, same shape.
  const getResult = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, method: "GET", path: "/" },
        (res) => {
          res.on("data", () => {})
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
        },
      )
      req.on("error", reject)
      req.setTimeout(3000, () => reject(new Error("GET hang")))
      req.end()
    },
  )
  assert.equal(getResult.status, 405)
  assert.match(String(getResult.headers["allow"] ?? ""), /POST/i)
})
