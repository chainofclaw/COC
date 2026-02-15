/**
 * Tests for HealthChecker, validateConfig, and RateLimiter
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { HealthChecker, validateConfig, RateLimiter } from "./health.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

// Minimal mock engine for health checks
function createMockEngine(overrides?: {
  height?: bigint
  blockTimestamp?: number
  mempoolSize?: number
  throwOnGetBlock?: boolean
}): IChainEngine {
  const height = overrides?.height ?? 5n
  const blockTimestamp = overrides?.blockTimestamp ?? Math.floor(Date.now() / 1000)
  const timestampMs = blockTimestamp * 1000
  const mempoolSz = overrides?.mempoolSize ?? 3
  const shouldThrow = overrides?.throwOnGetBlock ?? false

  return {
    mempool: { size: () => mempoolSz, stats: () => ({ pending: mempoolSz, senders: 1, totalGas: 0n }) } as any,
    events: {} as any,
    get height() { return height },
    async init() {},
    getTip() { return null },
    getHeight() { return height },
    getBlockByNumber(n: bigint) {
      if (shouldThrow) throw new Error("db error")
      if (n < 0n || n > height) return null
      return {
        number: n,
        hash: "0x1234" as Hex,
        parentHash: "0x0000" as Hex,
        proposer: "node-1",
        txs: [],
        timestampMs,
        stateRoot: "0x" as Hex,
      } as ChainBlock
    },
    getBlockByHash() { return null },
    getReceiptsByBlock() { return [] },
    expectedProposer() { return "node-1" },
    async addRawTx() { return {} as any },
    async proposeNextBlock() { return null },
    async applyBlock() {},
  } as unknown as IChainEngine
}

describe("HealthChecker", () => {
  let checker: HealthChecker

  beforeEach(() => {
    checker = new HealthChecker({ minPeers: 2, maxBlockAge: 30 })
  })

  it("returns healthy when all checks pass", async () => {
    const engine = createMockEngine()
    const result = await checker.check(engine, { peerCount: 5 })

    assert.equal(result.status, "healthy")
    assert.equal(result.chainId, 18780)
    assert.equal(result.nodeId, "node-1")
    assert.equal(result.latestBlock, 5n)
    assert.equal(result.peerCount, 5)
    assert.equal(result.mempoolSize, 3)
    assert.ok(result.checks.chain.ok)
    assert.ok(result.checks.peers.ok)
    assert.ok(result.checks.mempool.ok)
  })

  it("returns degraded when peers are low but chain is ok", async () => {
    const engine = createMockEngine()
    const result = await checker.check(engine, { peerCount: 1 })

    assert.equal(result.status, "degraded")
    assert.ok(result.checks.chain.ok)
    assert.ok(!result.checks.peers.ok)
  })

  it("returns degraded when block is stale", async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 120
    const engine = createMockEngine({ blockTimestamp: staleTimestamp })
    const result = await checker.check(engine, { peerCount: 5 })

    assert.equal(result.status, "degraded")
    assert.ok(!result.checks.blockFreshness.ok)
    assert.ok(result.checks.blockFreshness.message.includes("stale"))
  })

  it("returns unhealthy when chain check fails", async () => {
    const engine = createMockEngine({ throwOnGetBlock: true })
    const result = await checker.check(engine, { peerCount: 5 })

    assert.equal(result.status, "unhealthy")
    assert.ok(!result.checks.chain.ok)
    assert.ok(result.checks.chain.message.includes("chain check failed"))
  })

  it("reports uptime in seconds", async () => {
    const engine = createMockEngine()
    const result = await checker.check(engine)
    assert.equal(typeof result.uptime, "number")
    assert.ok(result.uptime >= 0)
  })

  it("handles genesis state (height=1)", async () => {
    const engine = createMockEngine({ height: 1n })
    const result = await checker.check(engine, { peerCount: 5 })

    assert.equal(result.latestBlock, 1n)
    assert.ok(result.checks.chain.ok)
  })

  it("uses default config values", async () => {
    const defaultChecker = new HealthChecker()
    const engine = createMockEngine()
    const result = await defaultChecker.check(engine)

    assert.equal(result.version, "0.1.0")
    assert.equal(result.chainId, 18780)
    assert.equal(result.nodeId, "node-1")
  })
})

describe("validateConfig", () => {
  it("returns no issues for valid config", () => {
    const issues = validateConfig({
      nodeId: "node-1",
      chainId: 18780,
      validators: ["node-1", "node-2"],
      rpcPort: 8545,
      blockTimeMs: 1000,
      finalityDepth: 3,
      maxTxPerBlock: 100,
    })
    const errors = issues.filter(i => i.severity === "error")
    assert.equal(errors.length, 0)
  })

  it("flags missing nodeId", () => {
    const issues = validateConfig({ chainId: 18780 })
    const nodeIdIssue = issues.find(i => i.field === "nodeId")
    assert.ok(nodeIdIssue)
    assert.equal(nodeIdIssue!.severity, "error")
  })

  it("flags invalid chainId", () => {
    const issues = validateConfig({ nodeId: "n1", chainId: -1 })
    const chainIdIssue = issues.find(i => i.field === "chainId")
    assert.ok(chainIdIssue)
    assert.equal(chainIdIssue!.severity, "error")
  })

  it("flags invalid port range", () => {
    const issues = validateConfig({
      nodeId: "n1", chainId: 1,
      rpcPort: 70000,
    })
    const portIssue = issues.find(i => i.field === "rpcPort" && i.severity === "error")
    assert.ok(portIssue)
  })

  it("warns on privileged ports", () => {
    const issues = validateConfig({
      nodeId: "n1", chainId: 1,
      rpcPort: 80,
    })
    const warning = issues.find(i => i.field === "rpcPort" && i.severity === "warning")
    assert.ok(warning)
    assert.ok(warning!.message.includes("privileged"))
  })

  it("warns on missing validators", () => {
    const issues = validateConfig({ nodeId: "n1", chainId: 1 })
    const valIssue = issues.find(i => i.field === "validators")
    assert.ok(valIssue)
    assert.equal(valIssue!.severity, "warning")
  })

  it("warns on extreme block times", () => {
    const issues1 = validateConfig({ nodeId: "n1", chainId: 1, blockTimeMs: 10 })
    assert.ok(issues1.find(i => i.field === "blockTimeMs" && i.message.includes("< 100ms")))

    const issues2 = validateConfig({ nodeId: "n1", chainId: 1, blockTimeMs: 120000 })
    assert.ok(issues2.find(i => i.field === "blockTimeMs" && i.message.includes("> 60s")))
  })

  it("flags invalid finalityDepth and maxTxPerBlock", () => {
    const issues = validateConfig({
      nodeId: "n1", chainId: 1,
      finalityDepth: 0,
      maxTxPerBlock: 0,
    })
    assert.ok(issues.find(i => i.field === "finalityDepth"))
    assert.ok(issues.find(i => i.field === "maxTxPerBlock"))
  })
})

describe("RateLimiter", () => {
  it("allows requests within token limit", () => {
    const limiter = new RateLimiter(5, 1)
    for (let i = 0; i < 5; i++) {
      assert.ok(limiter.allow("client-1"))
    }
  })

  it("blocks requests when tokens exhausted", () => {
    const limiter = new RateLimiter(3, 0)
    assert.ok(limiter.allow("client-1"))
    assert.ok(limiter.allow("client-1"))
    assert.ok(limiter.allow("client-1"))
    assert.ok(!limiter.allow("client-1"))
  })

  it("tracks remaining tokens", () => {
    const limiter = new RateLimiter(10, 0)
    assert.equal(limiter.remaining("new-client"), 10)
    limiter.allow("new-client")
    assert.ok(limiter.remaining("new-client") < 10)
  })

  it("isolates buckets per key", () => {
    const limiter = new RateLimiter(2, 0)
    limiter.allow("a")
    limiter.allow("a")
    assert.ok(!limiter.allow("a"))
    assert.ok(limiter.allow("b"))
  })

  it("resets a key", () => {
    const limiter = new RateLimiter(2, 0)
    limiter.allow("x")
    limiter.allow("x")
    assert.ok(!limiter.allow("x"))
    limiter.reset("x")
    assert.ok(limiter.allow("x"))
  })

  it("cleans up stale buckets", () => {
    const limiter = new RateLimiter(10, 1)
    limiter.allow("old-client")
    limiter.allow("fresh-client")
    // Stale threshold well into the future cleans all buckets
    limiter.cleanup(-1)
    // After cleanup, buckets are gone; remaining returns maxTokens
    assert.equal(limiter.remaining("old-client"), 10)
    assert.equal(limiter.remaining("fresh-client"), 10)
  })
})
