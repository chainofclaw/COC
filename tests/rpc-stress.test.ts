/**
 * RPC Endpoint Stress Tests
 *
 * Tests the HTTP RPC server under concurrent load.
 * NOTE: The RPC module uses a global rate limiter (200 req/60s per IP),
 * so all tests share a single server to stay within budget.
 *
 * Refs: #23
 */

import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { EvmChain } from "../node/src/evm.ts"
import { ChainEngine } from "../node/src/chain-engine.ts"
import { startRpcServer } from "../node/src/rpc.ts"
import type { P2PNode } from "../node/src/p2p.ts"

const CHAIN_ID = 18780
const FUNDER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

function createMockP2P(): P2PNode {
  return {
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
  } as P2PNode
}

async function postRpc(
  port: number,
  method: string,
  params: unknown[] = [],
  id: number = 1,
): Promise<{ status: number; body: Record<string, unknown>; latencyMs: number }> {
  const start = performance.now()
  const payload = JSON.stringify({ jsonrpc: "2.0", method, params, id })

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = ""
        res.on("data", (chunk: string) => (data += chunk))
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), latencyMs: performance.now() - start })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { error: data }, latencyMs: performance.now() - start })
          }
        })
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

async function postBatchRpc(
  port: number,
  requests: Array<{ method: string; params?: unknown[]; id: number }>,
): Promise<{ status: number; body: unknown[]; latencyMs: number }> {
  const start = performance.now()
  const payload = JSON.stringify(requests.map((r) => ({ jsonrpc: "2.0", ...r, params: r.params ?? [] })))

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = ""
        res.on("data", (chunk: string) => (data += chunk))
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), latencyMs: performance.now() - start })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: [], latencyMs: performance.now() - start })
          }
        })
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

// Shared server for all tests (avoids global rate limiter exhaustion)
let PORT = 29950 + Math.floor(Math.random() * 50)

describe("RPC Stress Tests", () => {
  before(async () => {
    const evm = await EvmChain.create(CHAIN_ID)
    await evm.prefund([{ address: FUNDER_ADDR, balanceWei: "100000000000000000000000" }])

    const engine = new ChainEngine(
      {
        dataDir: `/tmp/rpc-stress-${Date.now()}`,
        nodeId: FUNDER_ADDR.toLowerCase(),
        validators: [FUNDER_ADDR.toLowerCase()],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )

    startRpcServer("127.0.0.1", PORT, CHAIN_ID, evm, engine, createMockP2P())

    // Wait for server readiness
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 0 }),
        })
        if (res.ok) break
      } catch {
        await new Promise<void>((r) => setTimeout(r, 50))
      }
    }
  })

  // ── Throughput Baselines (run first to avoid rate limit) ──

  it("measures sequential RPC throughput (50 requests)", async () => {
    const count = 50
    const latencies: number[] = []
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      const { latencyMs } = await postRpc(PORT, "eth_blockNumber", [], i)
      latencies.push(latencyMs)
    }

    const duration = performance.now() - start
    const rps = (count / duration) * 1000
    const sorted = [...latencies].sort((a, b) => a - b)
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]

    console.log(`  Sequential: ${count} req in ${duration.toFixed(0)}ms (${rps.toFixed(0)} req/s, avg: ${avg.toFixed(1)}ms, P95: ${p95.toFixed(1)}ms)`)
    assert.ok(rps > 50, `Expected > 50 req/s, got ${rps.toFixed(0)}`)
  })

  it("measures batch RPC throughput", async () => {
    const batchSize = 20
    const { status, body, latencyMs } = await postBatchRpc(PORT, Array.from({ length: batchSize }, (_, i) => ({
      method: "eth_blockNumber",
      id: i + 1,
    })))

    console.log(`  Batch ${batchSize} requests: ${latencyMs.toFixed(0)}ms`)
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
    assert.equal(body.length, batchSize)
  })

  // ── Concurrent Read Operations ──

  it("handles 20 concurrent eth_getBalance requests", async () => {
    const start = performance.now()
    const promises = Array.from({ length: 20 }, (_, i) =>
      postRpc(PORT, "eth_getBalance", [FUNDER_ADDR, "latest"], i),
    )
    const results = await Promise.all(promises)
    const duration = performance.now() - start

    console.log(`  20 concurrent eth_getBalance: ${duration.toFixed(0)}ms`)

    for (const r of results) {
      assert.equal(r.status, 200)
      const body = r.body as { result?: string }
      assert.ok(body.result)
      assert.ok(BigInt(body.result) > 0n)
    }
    assert.ok(duration < 5000)
  })

  it("handles 10 concurrent eth_call requests", async () => {
    const start = performance.now()
    const promises = Array.from({ length: 10 }, (_, i) =>
      postRpc(PORT, "eth_call", [{ from: FUNDER_ADDR, to: FUNDER_ADDR, data: "0x" }, "latest"], i),
    )
    const results = await Promise.all(promises)
    const duration = performance.now() - start

    console.log(`  10 concurrent eth_call: ${duration.toFixed(0)}ms`)
    for (const r of results) {
      assert.equal(r.status, 200)
    }
    assert.ok(duration < 5000)
  })

  it("handles mixed read methods concurrently", async () => {
    const methods = [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_chainId", params: [] },
      { method: "eth_gasPrice", params: [] },
      { method: "net_version", params: [] },
      { method: "web3_clientVersion", params: [] },
    ]

    const start = performance.now()
    const promises = Array.from({ length: 15 }, (_, i) => {
      const m = methods[i % methods.length]
      return postRpc(PORT, m.method, m.params, i)
    })
    const results = await Promise.all(promises)
    const duration = performance.now() - start

    console.log(`  15 mixed concurrent reads: ${duration.toFixed(0)}ms`)

    let successCount = 0
    for (const r of results) {
      if (r.status === 200 && r.body.result !== undefined) successCount++
    }
    assert.ok(successCount >= 12, `Expected >= 12 successes, got ${successCount}`)
  })

  // ── Batch Requests ──

  it("handles batch of mixed methods", async () => {
    const requests = [
      { method: "eth_chainId", id: 1 },
      { method: "eth_blockNumber", id: 2 },
      { method: "eth_gasPrice", id: 3 },
      { method: "eth_getBalance", params: [FUNDER_ADDR, "latest"], id: 4 },
      { method: "net_version", id: 5 },
    ]

    const { status, body } = await postBatchRpc(PORT, requests)
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 5)
  })

  // ── Error Handling ──

  it("returns proper errors for invalid methods", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      postRpc(PORT, "eth_nonExistentMethod", [], i),
    )
    const results = await Promise.all(promises)

    for (const r of results) {
      assert.equal(r.status, 200)
      assert.ok(r.body.error)
    }
  })

  it("handles malformed requests gracefully", async () => {
    const send = (data: string): Promise<number> =>
      new Promise((resolve) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: PORT, method: "POST", headers: { "Content-Type": "application/json" } },
          (res) => resolve(res.statusCode ?? 0),
        )
        req.on("error", () => resolve(0))
        req.write(data)
        req.end()
      })

    const results = await Promise.all([
      send("not json"),
      send("{}"),
      send('{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'),
    ])

    assert.ok(results.some((s) => s === 200))
  })
})
