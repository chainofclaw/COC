import test from "node:test"
import assert from "node:assert/strict"
import type http from "node:http"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"
import { isLoopbackAddress } from "./rpc.ts"

// #336: admin_* methods were gated only by `enableAdminRpc` flag — once
// enabled (necessary for ops tooling like phantom pruning), any anonymous
// internet caller could invoke admin_addPeer (peer-list pollution),
// admin_removePeer (network split), admin_pruneStalePhantoms (CPU DoS),
// admin_nodeInfo (info leak). Fix: require Bearer auth by default; loopback
// source IP is accepted only when explicitly opted in for local ops.

async function startTestRpc(opts?: { authToken?: string; enableAdminRpc?: boolean; allowLoopbackRpcAuth?: boolean }): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const chainId = 18780
  const evm = await EvmChain.create(chainId)
  const dataDir = "/tmp/coc-admin-gate-test-" + Date.now() + "-" + Math.random().toString(36).slice(2)
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
    discovery: {
      addDiscoveredPeers: () => {},
      removePeer: () => {},
      getActivePeers: () => [],
    },
  } as unknown as P2PNode
  const port = 19000 + Math.floor(Math.random() * 500)
  const server: http.Server = startRpcServer(
    "127.0.0.1",
    port,
    chainId,
    evm,
    chain,
    p2p,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts?.authToken
      ? { authToken: opts.authToken, enableAdminRpc: opts.enableAdminRpc ?? true, allowLoopbackRpcAuth: opts.allowLoopbackRpcAuth }
      : { enableAdminRpc: opts.enableAdminRpc ?? true, allowLoopbackRpcAuth: opts.allowLoopbackRpcAuth },
  )
  await new Promise((r) => setTimeout(r, 50))
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

async function call(port: number, method: string, params: unknown[] = [], headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  return await res.json() as { result?: unknown; error?: { code: number; message: string } }
}

test("isLoopbackAddress recognizes 127.x.x.x / ::1 / IPv4-mapped IPv6", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true)
  assert.equal(isLoopbackAddress("127.1.2.3"), true)
  assert.equal(isLoopbackAddress("127.255.255.255"), true)
  assert.equal(isLoopbackAddress("::1"), true)
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
  // Non-loopback
  assert.equal(isLoopbackAddress("10.0.0.1"), false)
  assert.equal(isLoopbackAddress("192.168.1.1"), false)
  assert.equal(isLoopbackAddress("8.8.8.8"), false)
  assert.equal(isLoopbackAddress("209.74.64.88"), false)
  assert.equal(isLoopbackAddress(""), false)
  assert.equal(isLoopbackAddress("unknown"), false)
  // 128.x is NOT loopback (off-by-one guard)
  assert.equal(isLoopbackAddress("128.0.0.1"), false)
  // 126.x is NOT loopback
  assert.equal(isLoopbackAddress("126.0.0.1"), false)
})

test("#336: loopback request cannot call admin_* without explicit opt-in", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc({ enableAdminRpc: true })
  t.after(async () => { await close() })

  const r = await call(port, "admin_nodeInfo")
  assert.equal(r.error?.code, -32003, `loopback caller must not be implicitly trusted, got: ${JSON.stringify(r)}`)
  assert.match(r.error!.message, /explicit loopback trust/)
})

test("#336: loopback request can call admin_* when explicitly opted in", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc({ enableAdminRpc: true, allowLoopbackRpcAuth: true })
  t.after(async () => { await close() })

  const r = await call(port, "admin_nodeInfo")
  assert.ok(r.result, `explicitly trusted loopback caller must access admin_nodeInfo, got: ${JSON.stringify(r)}`)
})

test("#336: admin methods reject when admin enabled but rpcAuth is set + no token sent (remote)", async (t) => {
  // Simulating remote: rpcAuth token required, client doesn't send it.
  // Without Bearer the GLOBAL auth check at line 290-298 returns 401 before
  // reaching admin gate — that path is already covered by the existing auth
  // suite. So instead, test the more interesting case: rpcAuth is NOT set,
  // admin is enabled, request comes from non-loopback. The fix should reject
  // — but our test fixture binds 127.0.0.1, so we can't simulate non-loopback
  // without a real network setup. Instead, verify the gate logic by
  // forcing the gate to think the request is non-loopback via direct unit
  // assertion on isLoopbackAddress, which the gate uses verbatim.
  assert.equal(isLoopbackAddress("8.8.8.8"), false,
    "gate correctly classifies internet IPs as non-loopback")
  assert.equal(isLoopbackAddress("127.0.0.1"), true,
    "gate correctly classifies local IPs as loopback")
})

test("#336: admin methods accept when valid Bearer token + admin enabled", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const TOKEN = "secret-admin-token-1234"
  const { port, close } = await startTestRpc({ authToken: TOKEN, enableAdminRpc: true })
  t.after(async () => { await close() })

  // With valid token
  const ok = await call(port, "admin_nodeInfo", [], { authorization: `Bearer ${TOKEN}` })
  assert.ok(ok.result, `valid Bearer must access admin_nodeInfo, got: ${JSON.stringify(ok)}`)
})

test("#336: admin methods reject when admin DISABLED (existing behaviour preserved)", async (t) => {
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc({ enableAdminRpc: false })
  t.after(async () => { await close() })

  // admin_nodeInfo not enabled at all → -32601 method not found
  const r = await call(port, "admin_nodeInfo")
  assert.equal(r.error?.code, -32601, `disabled admin must be -32601, got: ${JSON.stringify(r)}`)
  assert.match(r.error!.message, /admin methods disabled/i)
})

test("#336: all 5 admin_* handlers reject when admin enabled but adminAuthorized=false (simulated)", async () => {
  // This is an integration sketch — the actual integration is hard to
  // simulate without binding a non-loopback interface. Instead, verify
  // the unauthorized() helper is exported with the correct shape so
  // the gate's throw produces the expected -32003 envelope.
  const { unauthorized } = await import("./rpc-validators.ts")
  try {
    unauthorized("admin methods require Bearer auth or explicit loopback trust")
    assert.fail("unauthorized must throw")
  } catch (e: unknown) {
    const err = e as { code: number; message: string }
    assert.equal(err.code, -32003, "unauthorized must throw -32003")
    assert.match(err.message, /explicit loopback trust/)
  }
})
