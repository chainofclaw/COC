import test from "node:test"
import assert from "node:assert/strict"
import type http from "node:http"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"

// #330: RPC server CORS — pre-fix hardcoded "http://localhost:3000" as
// the sole allowed origin. Production deployments forgetting to set the
// env var got an ACAO header that worked only for the dev origin,
// blocking every other browser client. This suite verifies:
//
//   - "*" wildcard via COC_CORS_ORIGIN="*"
//   - Comma-separated whitelist with per-request Origin echo
//   - Vary: Origin set when ACAO is per-request (not "*")
//   - OPTIONS preflight returns 204 (canonical)
//   - Unknown Origin falls back to the first whitelist entry (back-compat)

async function startTestRpc(): Promise<{ port: number; close: () => Promise<void> }> {
  const chainId = 18780
  const evm = await EvmChain.create(chainId)
  const dataDir = "/tmp/coc-rpc-cors-test-" + Date.now() + "-" + Math.random().toString(36).slice(2)
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
  const port = 19500 + Math.floor(Math.random() * 500)
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

async function probe(port: number, method: "POST" | "OPTIONS", origin?: string): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
}> {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method,
    headers: {
      ...(origin ? { "Origin": origin } : {}),
      "Content-Type": "application/json",
    },
    body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) : undefined,
  })
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => { headers[k] = v })
  if (method === "POST") await res.json()
  return { status: res.status, headers }
}

test("#330 RPC CORS — '*' wildcard via COC_CORS_ORIGIN=*", async (t) => {
  const prev = process.env.COC_CORS_ORIGIN
  process.env.COC_CORS_ORIGIN = "*"
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc()
  t.after(async () => {
    if (prev === undefined) delete process.env.COC_CORS_ORIGIN
    else process.env.COC_CORS_ORIGIN = prev
    await close()
  })
  const { headers } = await probe(port, "POST", "https://anywhere.example")
  assert.equal(headers["access-control-allow-origin"], "*", "wildcard must reflect to ACAO: *")
  assert.equal(headers["vary"], undefined, "Vary not needed when ACAO is *")
})

test("#330 RPC CORS — whitelist echoes matched Origin + sets Vary", async (t) => {
  const prev = process.env.COC_CORS_ORIGIN
  process.env.COC_CORS_ORIGIN = "https://app.coc.example,https://explorer.coc.example"
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc()
  t.after(async () => {
    if (prev === undefined) delete process.env.COC_CORS_ORIGIN
    else process.env.COC_CORS_ORIGIN = prev
    await close()
  })
  const r1 = await probe(port, "POST", "https://explorer.coc.example")
  assert.equal(r1.headers["access-control-allow-origin"], "https://explorer.coc.example",
    "whitelist match must echo origin")
  assert.equal(r1.headers["vary"], "Origin", "Vary: Origin must be set when ACAO varies")

  const r2 = await probe(port, "POST", "https://app.coc.example")
  assert.equal(r2.headers["access-control-allow-origin"], "https://app.coc.example",
    "second whitelist entry must echo too")
})

test("#330 RPC CORS — unknown Origin falls back to first whitelist entry (back-compat)", async (t) => {
  const prev = process.env.COC_CORS_ORIGIN
  process.env.COC_CORS_ORIGIN = "https://prod.coc.example,https://staging.coc.example"
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc()
  t.after(async () => {
    if (prev === undefined) delete process.env.COC_CORS_ORIGIN
    else process.env.COC_CORS_ORIGIN = prev
    await close()
  })
  const { headers } = await probe(port, "POST", "https://attacker.example")
  assert.equal(headers["access-control-allow-origin"], "https://prod.coc.example",
    "unmatched Origin falls back to first whitelist entry (browser denies cross-origin)")
})

test("#330 RPC CORS — OPTIONS preflight returns 204 No Content", async (t) => {
  const prev = process.env.COC_CORS_ORIGIN
  process.env.COC_CORS_ORIGIN = "https://app.coc.example"
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc()
  t.after(async () => {
    if (prev === undefined) delete process.env.COC_CORS_ORIGIN
    else process.env.COC_CORS_ORIGIN = prev
    await close()
  })
  const { status, headers } = await probe(port, "OPTIONS", "https://app.coc.example")
  assert.equal(status, 204, "OPTIONS preflight must be 204 No Content (RFC + Fetch spec)")
  assert.equal(headers["access-control-allow-methods"], "POST, OPTIONS",
    "preflight must advertise allowed methods")
  assert.match(String(headers["access-control-allow-headers"] ?? ""), /Content-Type/i,
    "preflight must advertise Content-Type allow")
})

test("#330 RPC CORS — default (env unset) preserves localhost dev fallback", async (t) => {
  const prev = process.env.COC_CORS_ORIGIN
  delete process.env.COC_CORS_ORIGIN
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const { port, close } = await startTestRpc()
  t.after(async () => {
    if (prev !== undefined) process.env.COC_CORS_ORIGIN = prev
    await close()
  })
  const r1 = await probe(port, "POST", "http://localhost:3000")
  assert.equal(r1.headers["access-control-allow-origin"], "http://localhost:3000",
    "default env unset must echo localhost:3000 for back-compat")
  const r2 = await probe(port, "POST", "https://prod.example")
  assert.equal(r2.headers["access-control-allow-origin"], "http://localhost:3000",
    "non-matching Origin falls back to default — browser denies cross-origin")
})
