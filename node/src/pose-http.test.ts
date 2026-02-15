import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { PoSeEngine } from "./pose-engine.ts"
import { buildReceiptSignMessage, createNodeSigner } from "./crypto/signer.ts"
import { registerPoseRoutes, handlePoseRequest } from "./pose-http.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

function createTestEngine(): PoSeEngine {
  const signer = createNodeSigner(TEST_PK)
  return new PoSeEngine(1n, { signer })
}

async function startTestServer(pose: PoSeEngine): Promise<{ port: number; close: () => void }> {
  const routes = registerPoseRoutes(pose)
  const server = http.createServer((req, res) => {
    if (!handlePoseRequest(routes, req, res)) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: "not found" }))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number }
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

async function fetchJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } },
      (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 500, data: JSON.parse(data || "{}") })
        })
      },
    )
    req.on("error", reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

test("GET /pose/status returns epochId", async () => {
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const { status, data } = await fetchJson(port, "GET", "/pose/status")
    assert.equal(status, 200)
    assert.equal(data.epochId, "1")
    assert.ok(data.ts)
  } finally {
    close()
  }
})

test("POST /pose/challenge returns challenge for valid nodeId", async () => {
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const { status, data } = await fetchJson(port, "POST", "/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })
    assert.equal(status, 200)
    assert.ok(data.challengeId)
    assert.ok(data.challengerSig)
  } finally {
    close()
  }
})

test("POST /pose/challenge rejects missing nodeId", async () => {
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const { status } = await fetchJson(port, "POST", "/pose/challenge", {})
    assert.equal(status, 400)
  } finally {
    close()
  }
})

test("POST /pose/receipt rejects missing fields", async () => {
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const { status } = await fetchJson(port, "POST", "/pose/receipt", {})
    assert.equal(status, 400)
  } finally {
    close()
  }
})

test("POST /pose/receipt accepts receipt by challengeId for issued challenge", async () => {
  const pose = createTestEngine()
  const signer = createNodeSigner(TEST_PK)
  const nodeId = `0x${signer.nodeId.slice(2).padStart(64, "0")}`
  const { port, close } = await startTestServer(pose)
  try {
    const challengeResp = await fetchJson(port, "POST", "/pose/challenge", { nodeId })
    assert.equal(challengeResp.status, 200)
    const challengeId = String(challengeResp.data.challengeId)
    const issuedAtMs = BigInt(String(challengeResp.data.issuedAtMs))

    const responseBody = { ok: true, blockNumber: 100 }
    const bodyHash = hashStable(responseBody)
    const msg = buildReceiptSignMessage(challengeId, nodeId, bodyHash)
    const nodeSig = signer.sign(msg)

    const receiptResp = await fetchJson(port, "POST", "/pose/receipt", {
      challengeId,
      receipt: {
        challengeId,
        nodeId,
        responseAtMs: (issuedAtMs + 100n).toString(),
        responseBody,
        nodeSig,
      },
    })
    assert.equal(receiptResp.status, 200)
    assert.equal(receiptResp.data.accepted, true)
  } finally {
    close()
  }
})

test("POST /pose/receipt rejects unknown challengeId", async () => {
  const pose = createTestEngine()
  const signer = createNodeSigner(TEST_PK)
  const nodeId = `0x${signer.nodeId.slice(2).padStart(64, "0")}`
  const { port, close } = await startTestServer(pose)
  try {
    const responseBody = { ok: true, blockNumber: 100 }
    const challengeId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const bodyHash = hashStable(responseBody)
    const msg = buildReceiptSignMessage(challengeId, nodeId, bodyHash)
    const nodeSig = signer.sign(msg)

    const receiptResp = await fetchJson(port, "POST", "/pose/receipt", {
      challengeId,
      receipt: {
        challengeId,
        nodeId,
        responseAtMs: "1000",
        responseBody,
        nodeSig,
      },
    })
    assert.equal(receiptResp.status, 400)
  } finally {
    close()
  }
})

test("unmatched route returns false from handlePoseRequest", () => {
  const pose = createTestEngine()
  const routes = registerPoseRoutes(pose)
  const req = { method: "GET", url: "/unknown" } as http.IncomingMessage
  const res = {} as http.ServerResponse
  const handled = handlePoseRequest(routes, req, res)
  assert.equal(handled, false)
})

function hashStable(value: unknown): `0x${string}` {
  return `0x${keccak256Hex(Buffer.from(stableStringify(value), "utf8"))}` as `0x${string}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${props.join(",")}}`
}
