import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { PoSeEngine } from "./pose-engine.ts"
import { createNodeSigner } from "./crypto/signer.ts"
import { registerPoseRoutes, handlePoseRequest } from "./pose-http.ts"

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

test("unmatched route returns false from handlePoseRequest", () => {
  const pose = createTestEngine()
  const routes = registerPoseRoutes(pose)
  const req = { method: "GET", url: "/unknown" } as http.IncomingMessage
  const res = {} as http.ServerResponse
  const handled = handlePoseRequest(routes, req, res)
  assert.equal(handled, false)
})
