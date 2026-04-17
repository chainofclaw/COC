import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { rpcCall, safeRpcQuery, resolveNodeRpcUrl, ALLOWED_RPC_METHODS } from "./rpc-client.ts"

// --- Mock RPC server ---

function createMockRpcServer(handler: (method: string, params: unknown[]) => unknown) {
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", () => {
      const { method, params, id } = JSON.parse(body) as { method: string; params: unknown[]; id: number }
      try {
        const result = handler(method, params)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { message: String(err) } }))
      }
    })
  })
  return server
}

describe("rpc-client", () => {
  let server: ReturnType<typeof createMockRpcServer>
  let port: number
  let url: string

  before(async () => {
    server = createMockRpcServer((method, params) => {
      if (method === "eth_blockNumber") return "0x42"
      if (method === "coc_chainStats") return { blocks: 66, txCount: 10, validators: 3 }
      if (method === "net_peerCount") return "0x3"
      if (method === "admin_shutdown") throw new Error("not allowed in mock")
      return null
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const addr = server.address() as { port: number }
    port = addr.port
    url = `http://127.0.0.1:${port}`
  })

  after(() => {
    server.close()
  })

  it("rpcCall returns result for valid method", async () => {
    const result = await rpcCall(url, "eth_blockNumber", [])
    assert.equal(result, "0x42")
  })

  it("rpcCall returns complex result", async () => {
    const result = await rpcCall(url, "coc_chainStats", []) as { blocks: number }
    assert.equal(result.blocks, 66)
  })

  it("rpcCall throws on server error", async () => {
    await assert.rejects(
      () => rpcCall(url, "admin_shutdown", []),
      /not allowed in mock/,
    )
  })

  it("ALLOWED_RPC_METHODS contains expected methods", () => {
    assert.ok(ALLOWED_RPC_METHODS.includes("eth_blockNumber"))
    assert.ok(ALLOWED_RPC_METHODS.includes("coc_chainStats"))
    assert.ok(ALLOWED_RPC_METHODS.includes("coc_getBftStatus"))
    assert.ok(ALLOWED_RPC_METHODS.includes("eth_getBalance"))
  })

  describe("safeRpcQuery", () => {
    let testDir: string

    before(async () => {
      testDir = join(tmpdir(), `rpc-client-test-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, "node-config.json"),
        JSON.stringify({ rpcPort: port, rpcBind: "127.0.0.1" }),
      )
    })

    after(async () => {
      await rm(testDir, { recursive: true, force: true })
    })

    it("rejects disallowed RPC method", async () => {
      await assert.rejects(
        () => safeRpcQuery(testDir, "admin_shutdown", []),
        /not allowed/,
      )
    })

    it("rejects eth_sendTransaction", async () => {
      await assert.rejects(
        () => safeRpcQuery(testDir, "eth_sendTransaction", []),
        /not allowed/,
      )
    })

    it("allows eth_blockNumber and returns result", async () => {
      const { result } = await safeRpcQuery(testDir, "eth_blockNumber", [])
      assert.equal(result, "0x42")
    })

    it("allows coc_chainStats and returns structured result", async () => {
      const { result } = await safeRpcQuery(testDir, "coc_chainStats", []) as { result: { blocks: number } }
      assert.equal(result.blocks, 66)
    })
  })

  describe("resolveNodeRpcUrl", () => {
    it("resolves URL from config file", async () => {
      const testDir = join(tmpdir(), `rpc-resolve-test-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, "node-config.json"),
        JSON.stringify({ rpcPort: 28780, rpcBind: "0.0.0.0" }),
      )
      const resolved = await resolveNodeRpcUrl(testDir)
      assert.equal(resolved, "http://127.0.0.1:28780")
      await rm(testDir, { recursive: true, force: true })
    })

    it("falls back to defaults when no config", async () => {
      const testDir = join(tmpdir(), `rpc-resolve-noconfig-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
      const resolved = await resolveNodeRpcUrl(testDir)
      assert.equal(resolved, "http://127.0.0.1:18780")
      await rm(testDir, { recursive: true, force: true })
    })
  })
})
