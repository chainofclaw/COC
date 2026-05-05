/**
 * Phase L.2d — upgrade skill (dry-run only) tests.
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

describe("upgrade skill", () => {
  beforeEach(() => uninstall())
  afterEach(() => {
    uninstall()
    delete process.env.COC_OPS_CONFIRM
  })

  it("dry-run: outputs plan with applied=false, exit 0", async () => {
    install((method) => {
      if (method === "coc_nodeInfo") return { clientVersion: "COC/0.2", nodeId: "0xf39f" }
      throw new Error(`unexpected ${method}`)
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json", "--target", "v1.0.0"])
      assert.equal(code, 0)
      const out = JSON.parse(chunks.join(""))
      assert.equal(out.schemaVersion, "0.2")
      assert.equal(out.applied, false)
      assert.match(out.target.image, /coc-node:v1\.0\.0/)
      assert.ok(out.actions.length >= 3)
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("--apply without --yes: exits 1 with UPGRADE_NEEDS_CONFIRM", async () => {
    install((method) => {
      if (method === "coc_nodeInfo") return { clientVersion: "COC/0.2", nodeId: "0xf39f" }
      throw new Error(`unexpected ${method}`)
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json", "--apply"])
      assert.equal(code, 1)
      const env = JSON.parse(chunks.join(""))
      assert.equal(env.error.code, "UPGRADE_NEEDS_CONFIRM")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("--apply --yes: exits 1 with UPGRADE_NOT_IMPLEMENTED (skeleton refuses to silently no-op)", async () => {
    install((method) => {
      if (method === "coc_nodeInfo") return { clientVersion: "COC/0.2", nodeId: "0xf39f" }
      throw new Error(`unexpected ${method}`)
    })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://x", "--json", "--apply", "--yes"])
      assert.equal(code, 1)
      const env = JSON.parse(chunks.join(""))
      assert.equal(env.error.code, "UPGRADE_NOT_IMPLEMENTED")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })

  it("dry-run still works when node RPC is unreachable", async () => {
    install((method) => { throw new Error(`ECONNREFUSED ${method}`) })

    const chunks: string[] = []
    const orig = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://localhost:1", "--json", "--timeout-ms", "20"])
      assert.equal(code, 0, "dry-run is best-effort even with RPC down")
      const out = JSON.parse(chunks.join(""))
      assert.equal(out.current.version, "<unknown>")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = orig as any
    }
  })
})
