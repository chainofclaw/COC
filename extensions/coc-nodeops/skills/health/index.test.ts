/**
 * Phase L.2c — health skill tests.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

interface FetchMockShape {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

let originalFetch: FetchMockShape | undefined

function install(handler: (method: string, params: unknown[]) => unknown): void {
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

describe("health skill", () => {
  beforeEach(() => uninstall())
  afterEach(() => uninstall())

  it("happy path: all checks green → ok=true, exit 0", async () => {
    install((method) => {
      switch (method) {
        case "coc_nodeInfo": return { clientVersion: "COC/0.2", nodeId: "0xf39f" }
        case "eth_blockNumber": return "0x10"
        case "eth_getBlockByNumber": {
          // Recent block (current time)
          return { timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` }
        }
        case "coc_diagnostics": return { syncProgress: { localHeight: "0x10", highestPeerHeight: "0x10" } }
        case "txpool_status": return { pending: 5, queued: 2 }
        default: throw new Error(`unexpected ${method}`)
      }
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json"])
      assert.equal(code, 0)
      const out = JSON.parse(chunks.join(""))
      assert.equal(out.schemaVersion, "0.2")
      assert.equal(out.ok, true)
      assert.equal(out.checks.length, 5, "5 checks")
      const names = out.checks.map((c: { name: string }) => c.name).sort()
      assert.deepEqual(names, ["bft.progress", "mempool.size", "rpc.reachable", "sync.gap", "validator.rotation"])
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("sync gap > 5: warn (not strict → exit 0)", async () => {
    install((method) => {
      switch (method) {
        case "coc_nodeInfo": return { nodeId: "0xf39f" }
        case "eth_blockNumber": return "0x10"
        case "eth_getBlockByNumber": return { timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` }
        case "coc_diagnostics": return { syncProgress: { localHeight: "0xa", highestPeerHeight: "0x14" } }
        case "txpool_status": return { pending: 0, queued: 0 }
        default: throw new Error(`unexpected ${method}`)
      }
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json"])
      // 10-block gap → "warn", overall ok=false → exit 1 (since ok=false)
      assert.equal(code, 1, "warn gap fails the overall ok check")
      const out = JSON.parse(chunks.join(""))
      assert.equal(out.ok, false)
      const sync = out.checks.find((c: { name: string }) => c.name === "sync.gap")
      assert.equal(sync.level, "warn")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("rpc unreachable: exit 1 (not 3) — health emits the report rather than aborting", async () => {
    // Mock fetch to reject the first coc_nodeInfo (used for resolving nodeId)
    // but other calls also fail. Health treats RPC failure as a "crit" check
    // result, not an exit-3 abort.
    install((method) => {
      if (method === "coc_nodeInfo") throw new Error("ECONNREFUSED")
      throw new Error("ECONNREFUSED")
    })

    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = () => true
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://localhost:1", "--json", "--timeout-ms", "20"])
      // RPC call inside checkRpcReachable returns crit; overall ok=false → exit 1
      assert.equal(code, 1)
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })
})
