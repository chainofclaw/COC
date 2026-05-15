/**
 * #374 regression: WebSocket RPC must validate the browser-sent
 * `Origin` header during the upgrade handshake to block Cross-Site
 * WebSocket Hijacking (CSWSH).
 *
 * Pre-fix the `WebSocketServer` was constructed without a
 * `verifyClient` hook, so ANY origin (`http://evil.com`) could open
 * a WebSocket from a victim's browser session and subscribe to the
 * node's pending-tx / log / block notifications, exfiltrating
 * mempool data and bypassing the HTTP CORS gate (#330).
 *
 * Live testnet 88780 reproduction (pre-fix):
 *
 *   $ node -e '
 *     const http = require("http")
 *     const req = http.request(
 *       { hostname: "199.192.16.79", port: 38781, method: "GET", path: "/",
 *         headers: { Connection: "Upgrade", Upgrade: "websocket",
 *                    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
 *                    "Sec-WebSocket-Version": 13, Origin: "http://evil.com" }})
 *     req.on("upgrade", () => console.log("UPGRADED — CSWSH!"))
 *     req.end()
 *   '
 *   → UPGRADED — CSWSH!
 *
 * Verify the post-fix upgrade handshake responds 403 when an explicit
 * Origin is not in the allowlist, accepts the allowlisted origin, and
 * accepts requests with NO Origin (non-browser clients — curl, ethers
 * Node provider).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { EvmChain } from "./evm.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { WsRpcServer } from "./websocket-rpc.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHAIN_ID = 18780
// #620: randomize the WS port to avoid EADDRINUSE collisions when this
// suite races other parallel test files. Pre-fix hardcoded 19899 worked
// when run alone, but Node's test runner schedules files concurrently
// and another suite occasionally bound 19899 first → this whole file's
// 3 tests failed with `listen EADDRINUSE` despite the code under test
// being correct. Three sequential tests use ports [base, base+1, base+2]
// so leave 8 slots of headroom.
const WS_PORT = 25000 + Math.floor(Math.random() * 5000)

interface ProbeResult {
  status: number
  upgraded: boolean
  body?: string
}

function probeUpgrade(port: number, origin: string | null): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Connection": "Upgrade",
      "Upgrade": "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
      "Host": "127.0.0.1",
    }
    if (origin !== null) headers.Origin = origin

    const req = http.request(
      { hostname: "127.0.0.1", port, method: "GET", path: "/", headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(Buffer.from(c)))
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, upgraded: false, body: Buffer.concat(chunks).toString() })
        })
      },
    )
    req.on("upgrade", (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 0, upgraded: true })
    })
    req.on("error", reject)
    req.setTimeout(3000, () => { req.destroy(new Error("probe timeout")); reject(new Error("probe timeout")) })
    req.end()
  })
}

test("#374: WebSocket upgrade rejects cross-origin requests by default", async (t) => {
  // Default behaviour: allowlist is "http://localhost:3000" (per env default).
  delete process.env.COC_WS_ORIGIN

  const tmp = await mkdtemp(join(tmpdir(), "ws-cswsh-test-"))
  const evm = await EvmChain.create(CHAIN_ID)
  const engine = new PersistentChainEngine(
    {
      dataDir: tmp,
      nodeId: "node-1",
      chainId: CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 2,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  await engine.init()

  const server = new WsRpcServer(
    { port: WS_PORT, bind: "127.0.0.1" },
    CHAIN_ID,
    evm,
    engine,
    { receiveTx: async () => {} } as unknown as Parameters<typeof WsRpcServer>[4],
    engine.events,
    async () => null,
  )
  server.start()
  await new Promise((r) => setTimeout(r, 100))

  t.after(async () => {
    server.stop()
    await engine.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
  })

  // 1. No Origin (non-browser): MUST upgrade — Same-Origin Policy
  //    doesn't apply, so there's no CSWSH risk to defend against.
  const noOrigin = await probeUpgrade(WS_PORT, null)
  assert.equal(noOrigin.upgraded, true, "no-Origin upgrade must succeed (non-browser clients)")
  assert.equal(noOrigin.status, 101)

  // 2. Origin http://evil.com (the CSWSH attacker case): MUST 403.
  const evil = await probeUpgrade(WS_PORT, "http://evil.com")
  assert.equal(evil.upgraded, false, "cross-origin upgrade MUST NOT succeed")
  assert.equal(evil.status, 403, `evil Origin must 403, got ${evil.status}`)

  // 3. Origin http://localhost:3000 (the default allowlist): MUST upgrade.
  const ok = await probeUpgrade(WS_PORT, "http://localhost:3000")
  assert.equal(ok.upgraded, true, "allowlisted origin must succeed")

  // 4. Origin "null" (browsers use this for sandboxed iframes / file://):
  //    rejected unless explicitly allowlisted.
  const nullOrig = await probeUpgrade(WS_PORT, "null")
  assert.equal(nullOrig.upgraded, false, "Origin: null must reject by default")
  assert.equal(nullOrig.status, 403)
})

test("#374: COC_WS_ORIGIN env extends the origin allowlist", async (t) => {
  process.env.COC_WS_ORIGIN = "http://explorer.example.com,http://other.example.org"

  const tmp = await mkdtemp(join(tmpdir(), "ws-cswsh-env-test-"))
  const evm = await EvmChain.create(CHAIN_ID)
  const engine = new PersistentChainEngine(
    {
      dataDir: tmp,
      nodeId: "node-1",
      chainId: CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 2,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  await engine.init()

  const server = new WsRpcServer(
    { port: WS_PORT + 1, bind: "127.0.0.1" },
    CHAIN_ID,
    evm,
    engine,
    { receiveTx: async () => {} } as unknown as Parameters<typeof WsRpcServer>[4],
    engine.events,
    async () => null,
  )
  server.start()
  await new Promise((r) => setTimeout(r, 100))

  t.after(async () => {
    server.stop()
    await engine.close()
    delete process.env.COC_WS_ORIGIN
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
  })

  // Allowlisted origins from env upgrade.
  const r1 = await probeUpgrade(WS_PORT + 1, "http://explorer.example.com")
  assert.equal(r1.upgraded, true, "first env origin must succeed")
  const r2 = await probeUpgrade(WS_PORT + 1, "http://other.example.org")
  assert.equal(r2.upgraded, true, "second env origin must succeed")

  // Old default (localhost:3000) is REPLACED by env — not in the list now.
  const r3 = await probeUpgrade(WS_PORT + 1, "http://localhost:3000")
  assert.equal(r3.upgraded, false, "default localhost rejected when env overrides")
  assert.equal(r3.status, 403)
})

test("#374: COC_WS_ORIGIN=\"*\" disables the origin check (operator opt-out)", async (t) => {
  process.env.COC_WS_ORIGIN = "*"

  const tmp = await mkdtemp(join(tmpdir(), "ws-cswsh-star-test-"))
  const evm = await EvmChain.create(CHAIN_ID)
  const engine = new PersistentChainEngine(
    {
      dataDir: tmp,
      nodeId: "node-1",
      chainId: CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 2,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  await engine.init()

  const server = new WsRpcServer(
    { port: WS_PORT + 2, bind: "127.0.0.1" },
    CHAIN_ID,
    evm,
    engine,
    { receiveTx: async () => {} } as unknown as Parameters<typeof WsRpcServer>[4],
    engine.events,
    async () => null,
  )
  server.start()
  await new Promise((r) => setTimeout(r, 100))

  t.after(async () => {
    server.stop()
    await engine.close()
    delete process.env.COC_WS_ORIGIN
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
  })

  // With *, every origin upgrades — including the attacker's.
  const r = await probeUpgrade(WS_PORT + 2, "http://evil.com")
  assert.equal(r.upgraded, true, 'COC_WS_ORIGIN="*" must accept every origin')
})
