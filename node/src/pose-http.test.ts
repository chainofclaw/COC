import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { PoSeEngine } from "./pose-engine.ts"
import { buildReceiptSignMessage, createNodeSigner } from "./crypto/signer.ts"
import { buildSignedPosePayload, registerPoseRoutes, handlePoseRequest } from "./pose-http.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

function createTestEngine(): PoSeEngine {
  const signer = createNodeSigner(TEST_PK)
  return new PoSeEngine(1n, { signer })
}

async function startTestServer(
  pose: PoSeEngine,
  authOptions?: {
    enableInboundAuth?: boolean
    inboundAuthMode?: "off" | "monitor" | "enforce"
    authMaxClockSkewMs?: number
    verifier?: ReturnType<typeof createNodeSigner>
    allowedChallengers?: string[]
    challengerAuthorizer?: { isAllowed: (senderId: string) => Promise<boolean> }
  },
): Promise<{ port: number; close: () => void }> {
  const routes = registerPoseRoutes(pose)
  const server = http.createServer((req, res) => {
    if (!handlePoseRequest(routes, req, res, authOptions)) {
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

test("POST /pose/challenge rejects invalid nodeId format", async () => {
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const { status } = await fetchJson(port, "POST", "/pose/challenge", { nodeId: "0x1234" })
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
    const responseAtMs = issuedAtMs + 100n
    const msg = buildReceiptSignMessage(challengeId, nodeId, bodyHash, responseAtMs)
    const nodeSig = signer.sign(msg)

    const receiptResp = await fetchJson(port, "POST", "/pose/receipt", {
      challengeId,
      receipt: {
        challengeId,
        nodeId,
        responseAtMs: responseAtMs.toString(),
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

test("#212: POST /pose/receipt rejects malformed responseAtMs without leaking V8 BigInt error", async () => {
  // Pre-fix `BigInt(String(rc.responseAtMs ?? 0))` threw a V8
  // SyntaxError ("Cannot convert [object Object] to a BigInt",
  // "Cannot convert 12.5 to a BigInt") for non-coercible inputs.
  // The outer catch carried the V8 wording through to clients —
  // same leak class as #176 (top-level catch / receipt-rejection
  // V8 leaks). Validate upfront so clients get a clean -32602-style
  // shape error instead.
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const validChId = "0x" + "1".repeat(64)
    const validNodeId = "0x" + "a".repeat(64)
    const validSig = "0x" + "f".repeat(130)
    const baseReceipt = {
      challengeId: validChId,
      nodeId: validNodeId,
      nodeSig: validSig,
    }
    const cases: Array<{ value: unknown; label: string }> = [
      { value: {}, label: "object" },
      { value: [1, 2], label: "array" },
      { value: "abc", label: "non-digit string" },
      { value: "12.5", label: "fractional string" },
      { value: -1, label: "negative number" },
      { value: 1.5, label: "fractional number" },
      { value: true, label: "boolean" },
    ]
    for (const { value, label } of cases) {
      const r = await fetchJson(port, "POST", "/pose/receipt", {
        challengeId: validChId,
        receipt: { ...baseReceipt, responseAtMs: value },
      })
      assert.equal(r.status, 400, `responseAtMs=${label} must be 400, got ${r.status}`)
      const errStr = String(r.data.error ?? "")
      assert.match(errStr, /responseAtMs/i, `${label}: error must name the field, got ${errStr}`)
      assert.doesNotMatch(errStr, /Cannot convert|BigInt|SyntaxError/i,
        `${label}: must not leak V8 BigInt error wording, got ${errStr}`)
    }
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

test("POST /pose/challenge rejects missing auth envelope in enforce mode", async () => {
  const pose = createTestEngine()
  const verifier = createNodeSigner(TEST_PK)
  const { port, close } = await startTestServer(pose, {
    inboundAuthMode: "enforce",
    verifier,
  })
  try {
    const { status } = await fetchJson(port, "POST", "/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })
    assert.equal(status, 401)
  } finally {
    close()
  }
})

test("POST /pose/challenge accepts signed payload in enforce mode", async () => {
  const pose = createTestEngine()
  const challenger = createNodeSigner(TEST_PK)
  const { port, close } = await startTestServer(pose, {
    inboundAuthMode: "enforce",
    verifier: challenger,
    allowedChallengers: [challenger.nodeId],
  })
  try {
    const signed = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, challenger, Date.now())
    const { status, data } = await fetchJson(port, "POST", "/pose/challenge", signed)
    assert.equal(status, 200)
    assert.ok(data.challengeId)
  } finally {
    close()
  }
})

test("POST /pose/challenge rejects signer not in allowlist", async () => {
  const pose = createTestEngine()
  const challenger = createNodeSigner(TEST_PK)
  const { port, close } = await startTestServer(pose, {
    inboundAuthMode: "enforce",
    verifier: challenger,
    allowedChallengers: ["0x1111111111111111111111111111111111111111"],
  })
  try {
    const signed = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, challenger, Date.now())
    const { status } = await fetchJson(port, "POST", "/pose/challenge", signed)
    assert.equal(status, 403)
  } finally {
    close()
  }
})

test("POST /pose/challenge allows signer via dynamic challenger authorizer", async () => {
  const pose = createTestEngine()
  const challenger = createNodeSigner(TEST_PK)
  const { port, close } = await startTestServer(pose, {
    inboundAuthMode: "enforce",
    verifier: challenger,
    allowedChallengers: [],
    challengerAuthorizer: {
      isAllowed: async (senderId: string) => senderId.toLowerCase() === challenger.nodeId.toLowerCase(),
    },
  })
  try {
    const signed = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, challenger, Date.now())
    const { status, data } = await fetchJson(port, "POST", "/pose/challenge", signed)
    assert.equal(status, 200)
    assert.ok(data.challengeId)
  } finally {
    close()
  }
})

test("POST /pose/challenge rejects signer when dynamic challenger authorizer denies", async () => {
  const pose = createTestEngine()
  const challenger = createNodeSigner(TEST_PK)
  const { port, close } = await startTestServer(pose, {
    inboundAuthMode: "enforce",
    verifier: challenger,
    allowedChallengers: [],
    challengerAuthorizer: {
      isAllowed: async () => false,
    },
  })
  try {
    const signed = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, challenger, Date.now())
    const { status } = await fetchJson(port, "POST", "/pose/challenge", signed)
    assert.equal(status, 403)
  } finally {
    close()
  }
})

test("#176: malformed JSON body returns generic error without V8 SyntaxError leak", async () => {
  // Pre-fix `String(error)` on JSON.parse failure surfaced the V8
  // SyntaxError class name + source position to clients — information
  // disclosure analogous to #156 (ethers leak) and #170 (Buffer.from
  // silent drop). Now sanitized to "invalid request".
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/pose/challenge", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          let data = ""
          res.on("data", (chunk) => (data += chunk))
          res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }))
        },
      )
      req.on("error", reject)
      req.write("not-json")
      req.end()
    })
    assert.equal(raw.status, 400)
    // The response body must NOT leak V8 internals — no "SyntaxError",
    // no source position offset, no Error class name.
    assert.doesNotMatch(raw.body, /SyntaxError|Unexpected token|position|Error:/, "must not leak V8 / Error class details")
    const json = JSON.parse(raw.body) as { error: string }
    assert.equal(json.error, "invalid request")
  } finally {
    close()
  }
})

test("#348: pose-http body read timeout closes slowloris connection", async () => {
  // Parity with #346 RPC body timeout — pre-fix pose-http had no body
  // inactivity timer, so an attacker sending `Content-Length: N` headers
  // and 0 body bytes held a request slot until Node's default ~5min
  // requestTimeout, draining the PoSe handler pool.
  const pose = createTestEngine()
  const { port, close } = await startTestServer(pose)
  try {
    const net = await import("node:net")
    await new Promise<void>((resolve, reject) => {
      const socket = net.default.createConnection(port, "127.0.0.1")
      const start = Date.now()
      let closed = false
      socket.on("connect", () => {
        // Headers say content-length:1000 but we never send body.
        socket.write(
          "POST /pose/challenge HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: 1000\r\n" +
          "\r\n"
        )
      })
      socket.on("close", () => {
        closed = true
        const elapsed = Date.now() - start
        // Production timeout is 30s; CI watchdog at 45s catches stuck-forever.
        assert.ok(elapsed < 45_000, `server-side timer must close socket within 45s; got ${elapsed}ms`)
        resolve()
      })
      socket.on("error", () => { closed = true; resolve() })
      setTimeout(() => {
        if (!closed) {
          socket.destroy()
          reject(new Error("server failed to close slowloris socket within 45s"))
        }
      }, 45_000).unref()
    })
  } finally {
    close()
  }
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
