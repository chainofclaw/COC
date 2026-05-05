/**
 * Phase L.2 — pose-status skill unit tests.
 *
 * Mocks fetch() to verify: happy path, RPC timeout (exit 3), JSON
 * envelope conformance to schemaVersion 0.2 spec.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

const SKELETON_OK_FIXTURE = {
  coc_nodeInfo: { clientVersion: "COC/0.2", nodeId: "0xabc", blockHeight: "0x1" },
  coc_poseStatus: {
    currentEpoch: 42,
    epochStartedAtMs: Date.now() - 14_000,
    challengesIssued: 38,
    receiptsVerified: 36,
    receiptsPending: 2,
    rewardPoolWei: "1500000000000000000",
    slashTotalWei: "0",
  },
}

interface FetchMockShape {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

let originalFetch: FetchMockShape | undefined

function installFetchMock(handler: (method: string, params: unknown[]) => unknown): void {
  originalFetch = (globalThis as { fetch?: FetchMockShape }).fetch
  ;(globalThis as { fetch: FetchMockShape }).fetch = async (input, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { method: string; params: unknown[] }
    const result = handler(body.method, body.params)
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
}

function installFetchTimeout(): void {
  originalFetch = (globalThis as { fetch?: FetchMockShape }).fetch
  ;(globalThis as { fetch: FetchMockShape }).fetch = async (_input, init) => {
    const signal = init?.signal as AbortSignal | undefined
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })
  }
}

function uninstallFetch(): void {
  if (originalFetch) {
    ;(globalThis as { fetch?: FetchMockShape }).fetch = originalFetch
  }
}

describe("pose-status skill", () => {
  beforeEach(() => { uninstallFetch() })
  afterEach(() => { uninstallFetch() })

  it("happy path: --json output conforms to schema 0.2", async () => {
    installFetchMock((method) => {
      if (method === "coc_nodeInfo") return SKELETON_OK_FIXTURE.coc_nodeInfo
      if (method === "coc_poseStatus") return SKELETON_OK_FIXTURE.coc_poseStatus
      throw new Error(`unexpected method ${method}`)
    })

    // Capture stdout
    const chunks: string[] = []
    const origWrite = process.stdout.write
    ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true }
    try {
      const { main } = await import("./index.ts")
      const code = await main(["--rpc", "http://localhost:99999", "--json"])
      assert.equal(code, 0, "exit code 0 on happy path")
      const out = JSON.parse(chunks.join(""))
      assert.equal(out.schemaVersion, "0.2", "schemaVersion frozen at 0.2")
      assert.equal(out.skill, "coc.pose-status")
      assert.equal(out.epoch.queriedEpoch, 42)
      assert.equal(out.metrics.challengesIssued, 38)
      assert.equal(out.health.ok, true, "no skew → health ok")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = origWrite as any
    }
  })

  it("rpc timeout: exit code 3", async () => {
    // Mock fetch to never resolve until aborted; AbortController fires
    // after the configured timeoutMs and rpcCall throws.
    installFetchTimeout()

    const { main } = await import("./index.ts")
    // Suppress output to avoid mixing with TAP stream — exit code is the
    // contract we're testing here, JSON envelope shape is exercised in
    // the happy-path test.
    const origStdout = process.stdout.write
    const origStderr = process.stderr.write
    ;(process.stdout as { write: (s: string) => boolean }).write = () => true
    ;(process.stderr as { write: (s: string) => boolean }).write = () => true
    try {
      const code = await main(["--rpc", "http://localhost:1", "--json", "--timeout-ms", "20"])
      assert.equal(code, 3, "exit code 3 on timeout")
    } finally {
      ;(process.stdout as { write: (s: string) => boolean }).write = origStdout as any
      ;(process.stderr as { write: (s: string) => boolean }).write = origStderr as any
    }
  })

  it("flag conflict: --watch + --json returns 2 without exiting", async () => {
    const { main } = await import("./index.ts")
    const code = await main(["--watch", "--json"])
    assert.equal(code, 2)
  })

  it("unknown flag: returns 2", async () => {
    const { main } = await import("./index.ts")
    const code = await main(["--bogus"])
    assert.equal(code, 2)
  })
})
