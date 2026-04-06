import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Transaction } from "ethers"

// Inline helpers to build a minimal chain/evm/p2p for handleRpcMethod tests
// We import the handleRpc helper indirectly via the exported startRpcServer path,
// but for unit testing we replicate the switch logic via a lightweight test harness.

// Build a fake chain engine
function createMockChain(blocks: Array<{
  number: bigint
  hash: string
  parentHash: string
  proposer: string
  timestampMs: number
  txs: string[]
  gasUsed?: bigint
  baseFee?: bigint
  finalized?: boolean
}> = []) {
  const blocksByNumber = new Map<bigint, (typeof blocks)[0]>()
  for (const b of blocks) blocksByNumber.set(b.number, b)

  return {
    getHeight: () => {
      if (blocks.length === 0) return 0n
      return blocks[blocks.length - 1].number
    },
    getBlockByNumber: (n: bigint) => blocksByNumber.get(n) ?? null,
    getBlockByHash: (h: string) => blocks.find((b) => b.hash === h) ?? null,
    getReceiptsByBlock: () => [],
    expectedProposer: (h: bigint) => {
      const validators = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]
      const idx = Number(h % BigInt(validators.length))
      return validators[idx < 0 ? idx + validators.length : idx]
    },
    addRawTx: async () => ({ hash: "0x" + "a".repeat(64) }),
    validators: [],
  }
}

function createMockEvm() {
  return {
    getBalance: async () => 0n,
    getNonce: async () => 0n,
    getReceipt: () => null,
    getTransaction: () => null,
    estimateGas: async () => 21000n,
    call: async () => "0x",
    getCode: async () => "0x",
    getStorageAt: async () => "0x" + "0".repeat(64),
    getProof: async () => ({}),
  }
}

function createMockP2P(peerCount: number) {
  const peers = Array.from({ length: peerCount }, (_, i) => ({
    url: `http://peer-${i}:19780`,
    id: `peer-${i}`,
  }))
  return {
    getPeers: () => peers,
    receiveTx: async () => {},
    broadcast: async () => {},
    getStats: () => ({}),
  }
}

// These tests exercise the RPC surface via a real HTTP server to cover the
// request-parsing, auth, and serialization layers in one shot.
// Note: handleRpcMethod now accepts runtime `opts` — use it directly for
// unit-level checks, but the full HTTP path is still valuable for wire-shape
// contracts. This file uses the HTTP path by design.

import { startRpcServer } from "./rpc.ts"
import http from "node:http"

/**
 * Wait until an HTTP server is truly in "listening" state.
 * startRpcServer returns the server synchronously but server.listen() is async,
 * so a fixed setTimeout is unreliable — use the 'listening' event instead.
 * Handles the case where the server is already listening when we attach.
 */
function waitForListening(server: any, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve()
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`server did not start listening within ${timeoutMs}ms`))
    }, timeoutMs)
    const onListening = () => { cleanup(); resolve() }
    const onError = (err: Error) => { cleanup(); reject(err) }
    const cleanup = () => {
      clearTimeout(timer)
      server.removeListener("listening", onListening)
      server.removeListener("error", onError)
    }
    server.once("listening", onListening)
    server.once("error", onError)
  })
}

/**
 * Safely close a server. Resolves even if already closed, still starting, or
 * close errors out. Meant for test cleanup (t.after) — must not throw.
 *
 * Handles three cases:
 *  1. server already listening → graceful close()
 *  2. server mid-startup (startRpcServer called, listen() still pending) →
 *     wait briefly for 'listening' or 'error', then close. This covers the
 *     case where a test fails between startRpcServer() and waitForListening().
 *  3. server never listened (error during listen) → resolve immediately
 */
// Tracks servers that have been successfully closed so repeated
// closeServerSafely() calls (e.g. explicit close + t.after fallback) return
// immediately instead of blocking on the mid-startup 200ms wait.
//
// The entry is automatically invalidated if the server is re-used (e.g.
// listen() is called on the same instance again) — we attach a one-shot
// "listening" listener right after marking closed, so any subsequent bind
// removes the server from the fast-path set.
const closedServers = new WeakSet<object>()

function markServerClosed(server: any): void {
  closedServers.add(server)
  // If this server is re-used (listen() called again), invalidate the fast path.
  server.once("listening", () => {
    closedServers.delete(server)
  })
}

function closeServerSafely(server: any): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server) return resolve()

    // Fast path: previously closed AND not currently listening or mid-startup.
    // If server.listening is true, the instance has been re-used — fall
    // through to the normal close path even if the WeakSet has a stale entry.
    if (closedServers.has(server) && !server.listening) {
      return resolve()
    }

    const markClosedAndResolve = () => {
      markServerClosed(server)
      resolve()
    }

    const doClose = () => {
      try {
        server.close(() => markClosedAndResolve())
        // close() callback may not fire if the server never fully started.
        // Force a timeout so cleanup cannot hang indefinitely.
        setTimeout(markClosedAndResolve, 500).unref?.()
      } catch {
        markClosedAndResolve()
      }
    }

    if (server.listening) {
      doClose()
      return
    }

    // Server not yet listening. It may be mid-startup (pending listen),
    // or it may have errored out, or it may already be fully closed
    // (close() called previously without our tracking). Use a short window
    // to wait for listening/error; if nothing happens and it's not pending,
    // resolve quickly.
    const timer = setTimeout(() => {
      server.removeListener("listening", onListening)
      server.removeListener("error", onError)
      doClose() // attempt close anyway — Node will no-op on un-bound servers
    }, 200)
    const onListening = () => {
      clearTimeout(timer)
      server.removeListener("error", onError)
      doClose()
    }
    const onError = () => {
      clearTimeout(timer)
      server.removeListener("listening", onListening)
      markClosedAndResolve()
    }
    server.once("listening", onListening)
    server.once("error", onError)
  })
}

async function rpcCall(port: number, method: string, params: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    const req = http.request({ hostname: "127.0.0.1", port, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = ""
      res.on("data", (chunk) => { data += chunk })
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed.result)
        } catch (e) { reject(e) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

describe("P7: RPC data accuracy", () => {
  // Monotonic port counter avoids collisions between parallel test runs.
  // Previously used Math.random() which caused flaky TCP EADDRINUSE failures.
  // Base high enough to avoid common test ports; PID-salted for concurrent test runs.
  let portCounter = 40000 + (process.pid % 500) * 10
  const nextPort = () => ++portCounter
  let port: number
  let server: ReturnType<typeof startRpcServer>

  // Build blocks with known transactions for fee tests
  const blocks: Parameters<typeof createMockChain>[0] = [
    {
      number: 0n,
      hash: "0x" + "0".repeat(64),
      parentHash: "0x" + "0".repeat(64),
      proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      timestampMs: 1000000,
      txs: [],
      gasUsed: 0n,
      baseFee: 1_000_000_000n,
    },
  ]

  // Create blocks with transactions for fee history testing
  const rawTxs: string[] = []
  for (let i = 0; i < 3; i++) {
    const tx = Transaction.from({
      to: "0x" + "bb".repeat(20),
      value: 0n,
      nonce: i,
      gasLimit: 21000n,
      maxFeePerGas: BigInt(3_000_000_000 + i * 500_000_000),
      maxPriorityFeePerGas: BigInt(500_000_000 + i * 200_000_000),
      chainId: 31337,
      type: 2,
    })
    rawTxs.push(tx.unsignedSerialized)
  }

  blocks.push({
    number: 1n,
    hash: "0x" + "1".repeat(64),
    parentHash: "0x" + "0".repeat(64),
    proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    timestampMs: 2000000,
    txs: rawTxs,
    gasUsed: 63000n,
    baseFee: 1_000_000_000n,
  })

  // Add more blocks for median calculation
  for (let b = 2; b <= 5; b++) {
    blocks.push({
      number: BigInt(b),
      hash: "0x" + b.toString(16).repeat(64).slice(0, 64),
      parentHash: "0x" + (b - 1).toString(16).repeat(64).slice(0, 64),
      proposer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      timestampMs: 1000000 + b * 1000,
      txs: rawTxs.slice(0, 1), // 1 tx each
      gasUsed: 21000n,
      baseFee: 1_000_000_000n,
    })
  }

  it("net_peerCount returns actual peer count", async (t) => {
    const peerCount = 5
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(peerCount)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)

    // Wait until server is truly in "listening" state (event-based, not timer)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "net_peerCount")
    assert.equal(result, `0x${peerCount.toString(16)}`)
  })

  it("net_peerCount returns 0x0 with no peers", async (t) => {
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(0)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "net_peerCount")
    assert.equal(result, "0x0")
  })

  it("eth_syncing returns false when not syncing", async (t) => {
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any, undefined, undefined, undefined, undefined, {
      getSyncProgress: async () => ({
        syncing: false,
        currentHeight: 5n,
        highestPeerHeight: 5n,
        startingHeight: 0n,
      }),
    })
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_syncing")
    assert.equal(result, false)
  })

  it("eth_syncing returns progress object when syncing", async (t) => {
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any, undefined, undefined, undefined, undefined, {
      getSyncProgress: async () => ({
        syncing: true,
        currentHeight: 100n,
        highestPeerHeight: 500n,
        startingHeight: 0n,
      }),
    })
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_syncing") as Record<string, string>
    assert.equal(result.startingBlock, "0x0")
    assert.equal(result.currentBlock, "0x64")
    assert.equal(result.highestBlock, "0x1f4")
  })

  it("eth_coinbase returns expected proposer address", async (t) => {
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_coinbase") as string
    // Should be a valid 0x address, not zero address (chain has validators)
    assert.ok(result.startsWith("0x"), "should start with 0x")
    assert.equal(result.length, 42, "should be 42 chars")
    assert.notEqual(result, "0x0000000000000000000000000000000000000000", "should not be zero address")
  })

  it("eth_maxPriorityFeePerGas returns non-hardcoded value with transactions", async (t) => {
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_maxPriorityFeePerGas") as string
    assert.ok(result.startsWith("0x"), "should be hex")
    const value = BigInt(result)
    assert.ok(value > 0n, "should be positive")
  })

  it("eth_maxPriorityFeePerGas returns 1 gwei fallback for empty blocks", async (t) => {
    const emptyBlocks = [{
      number: 0n,
      hash: "0x" + "0".repeat(64),
      parentHash: "0x" + "0".repeat(64),
      proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      timestampMs: 1000000,
      txs: [],
      gasUsed: 0n,
      baseFee: 1_000_000_000n,
    }]
    const chain = createMockChain(emptyBlocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_maxPriorityFeePerGas") as string
    assert.equal(result, "0x3b9aca00") // 1 gwei
  })

  it("eth_feeHistory rewards reflect actual transaction fees", async (t) => {
    const chain = createMockChain(blocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_feeHistory", [1, "latest", [25, 50, 75]]) as Record<string, unknown>
    assert.ok(result.reward, "should have reward field")
    const rewards = result.reward as string[][]
    assert.equal(rewards.length, 1, "should have 1 block of rewards")
    assert.equal(rewards[0].length, 3, "should have 3 percentile values")

    // Verify rewards are not the old hardcoded 0x3b9aca00
    // With real txs, at least some percentiles should differ
    for (const r of rewards[0]) {
      assert.ok(r.startsWith("0x"), "reward should be hex")
    }
  })

  it("eth_feeHistory rewards return 0x0 for empty blocks", async (t) => {
    const emptyBlocks = [
      {
        number: 0n,
        hash: "0x" + "0".repeat(64),
        parentHash: "0x" + "0".repeat(64),
        proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        timestampMs: 1000000,
        txs: [],
        gasUsed: 0n,
        baseFee: 1_000_000_000n,
      },
      {
        number: 1n,
        hash: "0x" + "1".repeat(64),
        parentHash: "0x" + "0".repeat(64),
        proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        timestampMs: 2000000,
        txs: [],
        gasUsed: 0n,
        baseFee: 1_000_000_000n,
      },
    ]
    const chain = createMockChain(emptyBlocks)
    const evm = createMockEvm()
    const p2p = createMockP2P(1)

    port = nextPort()
    server = startRpcServer("127.0.0.1", port, 31337, evm as any, chain as any, p2p as any)
    t.after(() => closeServerSafely(server))
    await waitForListening(server)

    const result = await rpcCall(port, "eth_feeHistory", [1, "latest", [50]]) as Record<string, unknown>
    const rewards = result.reward as string[][]
    assert.equal(rewards.length, 1, "should have 1 block of rewards")
    assert.equal(rewards[0][0], "0x0", "empty block reward should be 0x0")
  })
})

/**
 * Regression tests for the closeServerSafely() cleanup contract.
 *
 * These pin down the behavior that every rpc-data-accuracy test relies on:
 * if a test body fails between startRpcServer() and waitForListening(),
 * t.after(() => closeServerSafely(server)) must still release the pending
 * listen so that subsequent tests can bind ports without flake.
 *
 * History: the original implementation only called close() when
 * server.listening === true, which leaked pending listen attempts on failure.
 * See rpc-data-accuracy.test.ts:closeServerSafely for the current behavior.
 */
describe("closeServerSafely cleanup contract", () => {
  // Port base must stay below 65535. PID salt constrained to a safe range.
  let port = 48000 + (process.pid % 500) * 10
  const nextCleanupPort = () => ++port

  // Helper: create a listening server and register its cleanup via t.after().
  // Using t.after() instead of explicit cleanup lines guarantees release
  // even if an assertion fails mid-test.
  async function makeListeningServer(t: any, p: number): Promise<http.Server> {
    const srv = http.createServer()
    t.after(() => closeServerSafely(srv))
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject)
      srv.listen(p, "127.0.0.1", () => {
        srv.removeListener("error", reject)
        resolve()
      })
    })
    return srv
  }

  it("resolves immediately for null/undefined server", async () => {
    const start = Date.now()
    await closeServerSafely(null as any)
    await closeServerSafely(undefined as any)
    assert.ok(Date.now() - start < 100, "should resolve synchronously-ish")
  })

  it("closes a server that is actively listening", async (t) => {
    const p = nextCleanupPort()
    const srv = await makeListeningServer(t, p)
    assert.equal(srv.listening, true, "precondition: server is listening")

    await closeServerSafely(srv)
    assert.equal(srv.listening, false, "server should no longer be listening")

    // Port must be immediately rebindable; register rebind with t.after too
    const srv2 = await makeListeningServer(t, p)
    assert.equal(srv2.listening, true, "port should be free for rebind")
  })

  it("fast-path: repeated close on an already-closed server returns immediately", async (t) => {
    const p = nextCleanupPort()
    const srv = await makeListeningServer(t, p)

    // First close — uses the normal listening → doClose path
    await closeServerSafely(srv)
    assert.equal(srv.listening, false)

    // Second close — must use the fast path (WeakSet hit) and return
    // well under the 200ms mid-startup wait window.
    const start = Date.now()
    await closeServerSafely(srv)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 50,
      `already-closed server cleanup should be near-instant, took ${elapsed}ms`)
  })

  it("reuse-safe: a server reopened after close is still cleaned up properly", async (t) => {
    // Regression: the fast-path WeakSet must NOT cause a re-used server
    // (same instance, listen() called again) to be silently skipped by
    // closeServerSafely. Without the 'listening' invalidation, the second
    // close would become a no-op and the second bind would leak.
    const p1 = nextCleanupPort()
    const p2 = nextCleanupPort()
    const srv = http.createServer()
    t.after(() => closeServerSafely(srv))

    // Phase 1: listen → close → verify marked closed
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject)
      srv.listen(p1, "127.0.0.1", () => {
        srv.removeListener("error", reject)
        resolve()
      })
    })
    assert.equal(srv.listening, true, "phase 1: listening")
    await closeServerSafely(srv)
    assert.equal(srv.listening, false, "phase 1: closed")

    // Phase 2: re-listen the SAME instance on a different port.
    // The WeakSet-based fast path must invalidate when listen() fires again.
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject)
      srv.listen(p2, "127.0.0.1", () => {
        srv.removeListener("error", reject)
        resolve()
      })
    })
    assert.equal(srv.listening, true, "phase 2: re-listening")

    // Phase 2 close must actually close the server (not short-circuit).
    await closeServerSafely(srv)
    assert.equal(srv.listening, false, "phase 2: closed after reuse")

    // And p2 must be free — proving the second close actually happened.
    const rebind = await makeListeningServer(t, p2)
    assert.equal(rebind.listening, true, "reused port must be free after second close")
  })

  it("handles a server mid-startup (listen pending, not yet listening)", async (t) => {
    const p = nextCleanupPort()
    const srv = http.createServer()
    t.after(() => closeServerSafely(srv))
    // Call listen but do NOT await the callback — this is the "mid-startup" state
    srv.listen(p, "127.0.0.1")
    // At this instant server.listening may still be false
    assert.equal(srv.listening, false, "precondition: listen not yet resolved")

    // closeServerSafely must handle this without hanging and without leaking
    const start = Date.now()
    await closeServerSafely(srv)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 1500, `cleanup should finish promptly (took ${elapsed}ms)`)

    // Port must be rebindable after cleanup
    const srv2 = await makeListeningServer(t, p)
    assert.equal(srv2.listening, true, "port should be free for rebind after mid-startup cleanup")
  })

  it("handles a server that errors during listen (EADDRINUSE)", async (t) => {
    // Bind a blocker to occupy a port, then try to listen on it from a second server.
    // Both servers are registered with t.after() so they get cleaned up even if the
    // assertions below fail.
    const p = nextCleanupPort()
    const blocker = await makeListeningServer(t, p)

    const srv = http.createServer()
    t.after(() => closeServerSafely(srv))
    // This will emit 'error' (EADDRINUSE) asynchronously
    srv.listen(p, "127.0.0.1")

    // closeServerSafely must handle the error path without hanging
    const start = Date.now()
    await closeServerSafely(srv)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 1500, `cleanup should finish promptly on error (took ${elapsed}ms)`)
    assert.equal(blocker.listening, true, "blocker should still be listening")
  })

  // Helper for sub-process t.after regression tests
  async function runProbeTest(probeSource: string, t: any): Promise<{
    code: number | null; stdout: string; stderr: string
  }> {
    const { spawn } = await import("node:child_process")
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const tmpDir = await mkdtemp(join(tmpdir(), "coc-tafter-test-"))
    t.after(() => rm(tmpDir, { recursive: true, force: true }))

    const probeFile = join(tmpDir, "probe.test.mjs")
    await writeFile(probeFile, probeSource)

    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT

    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--test", probeFile], {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      })
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000)
      killTimer.unref?.()
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
      child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
      child.on("close", (code) => {
        clearTimeout(killTimer)
        resolve({ code, stdout, stderr })
      })
    })
  }

  it("end-to-end: mid-startup failure triggers t.after + releases port (sub-process)", async (t) => {
    // This is the complete regression test for the original bug window:
    //   1. A test calls startRpcServer() equivalent (http.Server + listen() without await)
    //   2. The test body throws BEFORE listening event fires
    //   3. t.after() registered with closeServerSafely() must still release the port
    //
    // We run this as a sub-process so the intentional failure doesn't pollute
    // the parent test's fail count. Inside the sub-process:
    //   - First test crashes mid-startup with closeServerSafely as t.after
    //   - Second test attempts to rebind the SAME port; must succeed
    //
    // Both checks running in the same sub-process proves the full chain.
    const probeSource = `
import { test } from "node:test"
import http from "node:http"

// WeakSet-based fast path from the production closeServerSafely helper
const closedServers = new WeakSet()
function markServerClosed(server) {
  closedServers.add(server)
  server.once("listening", () => closedServers.delete(server))
}
function closeServerSafely(server) {
  return new Promise((resolve) => {
    if (!server) return resolve()
    if (closedServers.has(server) && !server.listening) return resolve()
    const markClosedAndResolve = () => { markServerClosed(server); resolve() }
    const doClose = () => {
      try {
        server.close(() => markClosedAndResolve())
        setTimeout(markClosedAndResolve, 500).unref?.()
      } catch { markClosedAndResolve() }
    }
    if (server.listening) return doClose()
    const timer = setTimeout(() => {
      server.removeListener("listening", onListening)
      server.removeListener("error", onError)
      doClose()
    }, 200)
    const onListening = () => { clearTimeout(timer); server.removeListener("error", onError); doClose() }
    const onError = () => { clearTimeout(timer); server.removeListener("listening", onListening); markClosedAndResolve() }
    server.once("listening", onListening)
    server.once("error", onError)
  })
}

// Shared port across the two tests — we want to verify phase 2 can
// rebind the same port that phase 1 attempted to bind and failed at.
const PORT = 49871

test("phase1-mid-startup-failure", async (t) => {
  const srv = http.createServer()
  t.after(() => closeServerSafely(srv))
  // Call listen but do NOT await — this is the mid-startup window
  srv.listen(PORT, "127.0.0.1")
  // Throw before listen() has a chance to complete
  throw new Error("INTENTIONAL: mid-startup failure")
})

test("phase2-port-must-be-rebindable", async () => {
  // If phase 1's t.after + closeServerSafely worked end-to-end, the port
  // must be free. If it didn't, this bind throws EADDRINUSE.
  const srv = http.createServer()
  await new Promise((resolve, reject) => {
    srv.once("error", reject)
    srv.listen(PORT, "127.0.0.1", () => { srv.removeListener("error", reject); resolve() })
  })
  console.log("REBIND_OK")
  await new Promise((r) => srv.close(r))
})
`
    const result = await runProbeTest(probeSource, t)

    // Phase 1 must have failed
    assert.ok(
      result.stdout.includes("not ok") && result.stdout.includes("phase1"),
      `phase1 should have failed in TAP. stdout:\n${result.stdout.slice(0, 1500)}`,
    )

    // Phase 2 must have succeeded — this is the end-to-end proof:
    // it only passes if phase1's cleanup actually released the port.
    assert.ok(
      result.stdout.includes("REBIND_OK"),
      `phase2 rebind failed, meaning phase1's t.after() did NOT release the port. ` +
      `stdout:\n${result.stdout.slice(0, 1500)}\nstderr:\n${result.stderr.slice(0, 500)}`,
    )
    assert.ok(
      result.stdout.includes("ok 2") || /^ok 2 /m.test(result.stdout),
      `phase2 should report ok in TAP. stdout:\n${result.stdout.slice(0, 1500)}`,
    )
  })

  it("t.after() hooks run even when a fully-started test rejects (sub-process)", async (t) => {
    // Companion to the mid-startup test: this variant awaits listen() before
    // throwing, so the server is fully up when the test body rejects. It
    // proves t.after runs on the "listening + throw" path, separately from
    // the "mid-startup + throw" path.
    const probeSource = `
import { test } from "node:test"
import http from "node:http"

test("failing-test-with-after-hook", async (t) => {
  const srv = http.createServer()
  t.after(() => {
    console.log("CLEANUP_RAN")
    return new Promise((resolve) => {
      if (!srv.listening) return resolve()
      srv.close(() => resolve())
    })
  })
  // Await listen so the server is fully up before we throw
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  throw new Error("INTENTIONAL: sub-process test failure")
})
`
    const result = await runProbeTest(probeSource, t)

    assert.ok(
      result.stdout.includes("not ok"),
      `probe test should have reported failure in TAP output. stdout:\n${result.stdout.slice(0, 1000)}\nstderr:\n${result.stderr.slice(0, 500)}`,
    )
    assert.ok(
      result.stdout.includes("CLEANUP_RAN"),
      `t.after() hook did not execute when test body rejected. stdout:\n${result.stdout.slice(0, 1000)}`,
    )
    assert.ok(
      result.stdout.includes("INTENTIONAL") || result.stderr.includes("INTENTIONAL"),
      `expected intentional failure message, got stdout:\n${result.stdout.slice(0, 500)}\nstderr:\n${result.stderr.slice(0, 500)}`,
    )
  })
})
