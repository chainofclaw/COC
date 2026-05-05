/**
 * Phase L.2b — chain-stats skill tests.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

interface FetchMockShape {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

let originalFetch: FetchMockShape | undefined

function installRpcMock(handler: (method: string, params: unknown[]) => unknown): void {
  originalFetch = (globalThis as { fetch?: FetchMockShape }).fetch
  ;(globalThis as { fetch: FetchMockShape }).fetch = async (_input, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { method: string; params: unknown[] }
    const result = handler(body.method, body.params)
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })
  }
}

function uninstall(): void {
  if (originalFetch) (globalThis as { fetch?: FetchMockShape }).fetch = originalFetch
}

function buildBlockFixture(height: number, timestampSec: number, txCount: number): unknown {
  return {
    number: `0x${height.toString(16)}`,
    timestamp: `0x${timestampSec.toString(16)}`,
    transactions: Array.from({ length: txCount }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`),
    gasUsed: "0xa410", // 42000
    baseFeePerGas: "0x3b9aca00", // 1 gwei
    miner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  }
}

describe("chain-stats skill", () => {
  beforeEach(() => uninstall())
  afterEach(() => uninstall())

  it("happy path: --json outputs schema 0.2 with sample blocks", async () => {
    let getBlockCalls = 0
    installRpcMock((method, params) => {
      switch (method) {
        case "eth_blockNumber": return "0x64" // 100
        case "coc_nodeInfo": return { clientVersion: "COC/0.2", nodeId: "0xf39f", blockHeight: "0x64" }
        case "eth_getBlockByNumber": {
          const heightHex = (params[0] as string)
          const height = Number(heightHex)
          // Fake timestamps: tip = 100s; each block 3s earlier
          const ts = 100 - 3 * (100 - height)
          getBlockCalls++
          return buildBlockFixture(height, ts, 5)
        }
        default: throw new Error(`unexpected ${method}`)
      }
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json", "--window", "30s"])
      assert.equal(code, 0)
      const out = JSON.parse(chunks.join(""))
      assert.equal(out.schemaVersion, "0.2")
      assert.equal(out.skill, "coc.chain-stats")
      assert.equal(out.blocks.tipHeight, 100)
      assert.ok(out.blocks.count >= 1, "at least 1 block sampled")
      assert.ok(getBlockCalls >= 1)
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("--validators flag includes per-validator breakdown", async () => {
    installRpcMock((method, params) => {
      switch (method) {
        case "eth_blockNumber": return "0x2"
        case "coc_nodeInfo": return { clientVersion: "COC/0.2", nodeId: "0xf39f", blockHeight: "0x2" }
        case "eth_getBlockByNumber": {
          const height = Number(params[0] as string)
          return buildBlockFixture(height, 100 - 3 * (2 - height), 3)
        }
        default: throw new Error(`unexpected ${method}`)
      }
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json", "--window", "30s", "--validators"])
      assert.equal(code, 0)
      const out = JSON.parse(chunks.join(""))
      assert.ok(Array.isArray(out.validators), "validators array present")
      assert.ok(out.validators.length >= 1, "at least one proposer reported")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("bad --window: returns 2", async () => {
    const { main } = await import("./index.ts")
    const orig = process.stderr.write
    ;(process.stderr as { write: (s: string) => boolean }).write = () => true
    try {
      const code = await main(["--window", "lol"])
      assert.equal(code, 2)
    } finally {
      ;(process.stderr as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("unknown skill flag: returns 2", async () => {
    const { main } = await import("./index.ts")
    const orig = process.stderr.write
    ;(process.stderr as { write: (s: string) => boolean }).write = () => true
    try {
      const code = await main(["--bogus"])
      assert.equal(code, 2)
    } finally {
      ;(process.stderr as { write: (s: string) => boolean }).write = orig as any
    }
  })
})
