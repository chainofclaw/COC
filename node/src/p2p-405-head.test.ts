/**
 * #378 regression: non-POST requests to the P2P HTTP gossip server
 * must return 405 with explicit `Content-Length: 0` so HEAD requests
 * terminate immediately instead of hanging until the keep-alive
 * timeout fires.
 *
 * Same pattern as #376 (RPC server) — pre-fix
 * `res.writeHead(405); res.end()` defaulted to chunked
 * Transfer-Encoding. For HEAD requests, Node suppresses the body but
 * still advertises chunked, so the client waits for a terminating
 * chunk that never arrives, hanging until the 5 s keepAliveTimeout
 * fires.
 *
 * Live testnet 88780 reproduction (pre-fix):
 *
 *   $ time curl -X HEAD http://199.192.16.79:29780/
 *   → 6.48 s  (5 s keep-alive + RTT)
 *
 * Real-world impact: deployments that expose the P2P port to a load
 * balancer (e.g. for cross-region replication health checks) face
 * the same socket-pool exhaustion as #376.
 *
 * Fix sets `Content-Length: 0` + `Allow: POST` (RFC 7231 §6.5.5)
 * on the 405 so HEAD / GET / PUT / DELETE all terminate immediately.
 */

import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { P2PNode } from "./p2p.ts"
import type { Hex, ChainSnapshot } from "./blockchain-types.ts"

test("#378: HEAD request to P2P server returns 405 with Content-Length: 0 (no hang)", async (t) => {
  const port = 29900 + Math.floor(Math.random() * 100)
  const p2p = new P2PNode(
    {
      bind: "127.0.0.1",
      port,
      peers: [],
      nodeId: "test-378",
      enableDiscovery: false,
    },
    {
      onTx: async () => {},
      onBlock: async () => {},
      onSnapshotRequest: () =>
        ({ height: 0, latestHash: "0x0" as Hex, blocks: [] }) as unknown as ChainSnapshot,
      getHeight: () => 0n,
    },
  )
  p2p.start()
  t.after(async () => {
    await p2p.stop()
  })
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
      req.setTimeout(3000, () => {
        req.destroy(new Error("HEAD hang — pre-fix bug shape"))
        reject(new Error("HEAD hang — pre-fix bug shape"))
      })
      req.end()
    },
  )
  const elapsed = Date.now() - start

  assert.equal(result.status, 405, "HEAD must return 405 Method Not Allowed")
  assert.equal(
    result.headers["content-length"],
    "0",
    "Content-Length must be 0 (no body to wait for)",
  )
  assert.match(
    String(result.headers["allow"] ?? ""),
    /POST/i,
    "RFC 7231 §6.5.5: 405 must include Allow header listing supported methods",
  )
  assert.ok(
    elapsed < 1000,
    `HEAD must terminate quickly (got ${elapsed} ms — pre-fix hung ~5 s on keep-alive timeout)`,
  )

  // GET also rejected with 405, same shape.
  const getResult = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, method: "GET", path: "/wire" },
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

  // PUT and DELETE too — proves the fix is method-agnostic.
  for (const method of ["PUT", "DELETE"]) {
    const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, method, path: "/" },
          (res) => {
            res.on("data", () => {})
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers }),
            )
          },
        )
        req.on("error", reject)
        req.setTimeout(3000, () => reject(new Error(`${method} hang`)))
        req.end()
      },
    )
    assert.equal(r.status, 405, `${method} must return 405`)
    assert.equal(r.headers["content-length"], "0", `${method} must set Content-Length: 0`)
  }
})
