import test from "node:test"
import assert from "node:assert/strict"
import {
  ConsensusEngine,
  NO_PROGRESS_TIMEOUT_MS,
  NO_PROGRESS_STAGGER_MS,
  PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS,
  PROPOSER_UNREACHABLE_TTL_MS,
} from "./consensus.ts"

/**
 * PR-1A: Proposer slot skip 机制
 *
 * 2026-05-10 N=5 attempt #2 实测发现:N=5 BFT 在单 validator 不可达时立即冻结链,
 * 与 N 无关。根因是 expectedProposer() 用 (height-1) % N 选 proposer,无 skip 机制;
 * round timeout 后只清理不推进高度;只能等 H15 600s NO_PROGRESS_TIMEOUT_MS 兜底。
 *
 * 修复:
 *   1. 新增 markProposerUnreachable(id) — 由 BFT round timeout 调用
 *   2. 新增 reachabilityProvider opt — 暴露 wire-connection-manager 已连接 peer 集合
 *   3. checkNoProgressWatchdog 当 stuck proposer 不可达时,fast-path 用
 *      PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS (15s) 替代 600s 触发 fallback
 *   4. unreachable 标记 60s TTL,持续 unreachable 期间会被 BFT timeout / wire 事件刷新
 */

const VALIDATORS_5 = ["node-1", "node-2", "node-3", "node-4", "node-5"]

function mkMockChain(validators: string[]): any {
  return {
    getHeight: async () => 0n,
    getTip: async () => null,
    expectedProposer: (h: bigint) =>
      validators[Number((h - 1n) % BigInt(validators.length))],
    mempool: { getPendingTxs: () => [] },
    events: { on: () => {}, off: () => {} },
  }
}

const mkMockP2p = (): any => ({
  fetchSnapshots: async () => [],
  receiveBlock: async () => {},
})

const mkMockBft = (): any => ({
  getRoundState: () => ({ active: false }),
  stop: () => {},
})

test("PR-1A: markProposerUnreachable records id with TTL", () => {
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mkMockBft(), nodeId: "node-2" },
  )

  c.markProposerUnreachable("node-1")
  assert.equal((c as any).isProposerUnreachable("node-1"), true)
  assert.equal((c as any).isProposerUnreachable("NODE-1"), true, "case-insensitive")
  assert.equal((c as any).isProposerUnreachable("node-3"), false)

  // After expiry the entry should be cleared on next query
  ;(c as any).unreachableProposers.set("node-1", Date.now() - 1)
  assert.equal((c as any).isProposerUnreachable("node-1"), false)
  assert.equal(
    (c as any).unreachableProposers.has("node-1"),
    false,
    "expired entries are pruned on read",
  )
})

test("PR-1A: reachabilityProvider drives isProposerUnreachable for non-self ids", () => {
  const reachable = new Set<string>()
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    {
      bft: mkMockBft(),
      nodeId: "node-2",
      reachabilityProvider: () => reachable,
    },
  )

  // Empty reachable set → all peers (except self) are considered unreachable
  assert.equal((c as any).isProposerUnreachable("node-1"), true, "missing-from-reachable counts as unreachable")
  // Self is never marked unreachable by the reachability provider
  assert.equal((c as any).isProposerUnreachable("node-2"), false, "self is always reachable")

  reachable.add("node-1")
  assert.equal((c as any).isProposerUnreachable("node-1"), false, "now reachable")
})

test("PR-1A: fast watchdog fires at 15s when stuck proposer marked unreachable", async () => {
  // N=5 chain. expectedProposer(1) = node-1 (stuck). Local = node-2 (offset 1 fallback).
  // With unreachable evidence, override should arm at PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS,
  // not at NO_PROGRESS_TIMEOUT_MS (600s).
  const mockChain = mkMockChain(VALIDATORS_5)
  const mockP2p = mkMockP2p()
  const mockBft = mkMockBft()

  const c = new ConsensusEngine(
    mockChain,
    mockP2p,
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mockBft, nodeId: "node-2" },
  )

  c.markProposerUnreachable("node-1")

  // Below fast threshold → no arming
  ;(c as any).lastBftProgressAtMs = Date.now() - (PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS - 2_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal((c as any).noProgressProposerOverride, false, "below fast threshold: no arm")

  // Above fast threshold and well below H15 → arms
  ;(c as any).lastBftProgressAtMs = Date.now() - (PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS + 2_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal((c as any).noProgressProposerOverride, true, "fast watchdog arms when proposer unreachable")
})

test("PR-1A: without unreachable evidence, slow path (600s) governs", async () => {
  const mockChain = mkMockChain(VALIDATORS_5)
  const c = new ConsensusEngine(
    mockChain,
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mkMockBft(), nodeId: "node-2" },
  )

  // No markProposerUnreachable call. Even at 30s elapsed (well past fast threshold),
  // the override must NOT arm — without evidence we keep the conservative behaviour.
  ;(c as any).lastBftProgressAtMs = Date.now() - 30_000
  await (c as any).checkNoProgressWatchdog()
  assert.equal((c as any).noProgressProposerOverride, false, "no evidence: slow path")

  // Slow path eventually fires at NO_PROGRESS_TIMEOUT_MS as before
  ;(c as any).lastBftProgressAtMs = Date.now() - (NO_PROGRESS_TIMEOUT_MS + 5_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal((c as any).noProgressProposerOverride, true, "slow path still works")
})

test("PR-1A: fast path respects rotation stagger across multiple fallbacks", async () => {
  // 2026-05-02 regression: ALL nodes armed override simultaneously → equivocation storm.
  // Same protection must hold on the fast path.
  // Setup: stuck = node-1 (offset 0). Primary fallback = node-2 (offset 1).
  // Secondary = node-3 (offset 2). Tertiary = node-4 (offset 3) ...

  async function fires(localId: string, elapsedMs: number): Promise<boolean> {
    const c = new ConsensusEngine(
      mkMockChain(VALIDATORS_5),
      mkMockP2p(),
      { blockTimeMs: 1000, syncIntervalMs: 300_000 },
      { bft: mkMockBft(), nodeId: localId },
    )
    c.markProposerUnreachable("node-1")
    ;(c as any).lastBftProgressAtMs = Date.now() - elapsedMs
    await (c as any).checkNoProgressWatchdog()
    return (c as any).noProgressProposerOverride === true
  }

  const FAST = PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS
  const STAG = NO_PROGRESS_STAGGER_MS

  // Stuck proposer (node-1) NEVER arms (its own slot)
  assert.equal(await fires("node-1", FAST + 5 * STAG), false, "stuck proposer never arms")

  // Primary fallback fires at FAST
  assert.equal(await fires("node-2", FAST - 2_000), false, "node-2 below fast threshold")
  assert.equal(await fires("node-2", FAST + 2_000), true, "node-2 arms at fast threshold")

  // Secondary fallback fires at FAST + STAG
  assert.equal(await fires("node-3", FAST + 2_000), false, "node-3 below secondary threshold")
  assert.equal(await fires("node-3", FAST + STAG + 2_000), true, "node-3 arms at secondary threshold")

  // Tertiary fallback fires at FAST + 2*STAG
  assert.equal(
    await fires("node-4", FAST + STAG + 2_000),
    false,
    "node-4 below tertiary threshold",
  )
  assert.equal(
    await fires("node-4", FAST + 2 * STAG + 2_000),
    true,
    "node-4 arms at tertiary threshold",
  )
})

test("PR-1A: notifyBftProgress clears unreachable mark for stuck proposer", () => {
  // When the stuck proposer recovers and successfully finalizes a block,
  // notifyBftProgress should clear all unreachable marks so the next slot
  // tick goes back to the normal round-robin path.
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mkMockBft(), nodeId: "node-2" },
  )

  c.markProposerUnreachable("node-1")
  c.markProposerUnreachable("node-3")
  assert.equal((c as any).unreachableProposers.size, 2)

  c.notifyBftProgress()
  assert.equal(
    (c as any).unreachableProposers.size,
    0,
    "successful finalize clears all unreachable marks",
  )
})

test("PR-1H: markProposerUnreachable is a no-op during startup grace", () => {
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mkMockBft(), nodeId: "node-2" },
  )

  // Simulate that consensus has been running for only 1 s (well inside grace).
  ;(c as any).startedAtMs = Date.now() - 1_000

  c.markProposerUnreachable("node-1")
  assert.equal(
    (c as any).unreachableProposers.size,
    0,
    "grace period prevents mark from being recorded",
  )
  assert.equal(
    (c as any).isProposerUnreachable("node-1"),
    false,
    "grace period prevents isProposerUnreachable from reporting true",
  )
})

test("PR-1H: markProposerUnreachable activates after startup grace expires", () => {
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mkMockBft(), nodeId: "node-2" },
  )

  // Simulate that consensus has been running for 90 s (past 60 s grace).
  ;(c as any).startedAtMs = Date.now() - 90_000

  c.markProposerUnreachable("node-1")
  assert.equal((c as any).unreachableProposers.size, 1, "mark recorded after grace")
  assert.equal((c as any).isProposerUnreachable("node-1"), true, "reachability check active after grace")
})

test("PR-1H: isProposerUnreachable always false during grace, ignoring reachabilityProvider", () => {
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    {
      bft: mkMockBft(),
      nodeId: "node-2",
      reachabilityProvider: () => new Set(["node-2"]), // excludes everyone else
    },
  )

  // During grace, reachabilityProvider should be ignored.
  ;(c as any).startedAtMs = Date.now() - 5_000
  assert.equal(
    (c as any).isProposerUnreachable("node-1"),
    false,
    "reachabilityProvider ignored during grace",
  )

  // After grace, reachabilityProvider takes effect.
  ;(c as any).startedAtMs = Date.now() - 90_000
  assert.equal(
    (c as any).isProposerUnreachable("node-1"),
    true,
    "reachabilityProvider reports node-1 unreachable after grace",
  )
})

test("PR-1H: noProgressWatchdog falls back to slow path during grace even when proposer is unreachable", async () => {
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft: mkMockBft(), nodeId: "node-2" },
  )
  ;(c as any).startedAtMs = Date.now() - 5_000

  c.markProposerUnreachable("node-1") // no-op during grace
  ;(c as any).lastBftProgressAtMs = Date.now() - (PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS + 5_000)

  await (c as any).checkNoProgressWatchdog()
  assert.equal(
    (c as any).noProgressProposerOverride,
    false,
    "fast path is disarmed during startup grace",
  )
})

test("PR-1A: TTL constant is reasonable", () => {
  // Sanity check the constants relate sensibly:
  //   FAST < TTL  (a single round must not expire its own evidence mid-flight)
  //   FAST < NO_PROGRESS_TIMEOUT_MS (fast path must beat slow path)
  //   TTL <= NO_PROGRESS_TIMEOUT_MS (don't keep stale evidence past slow-path window)
  assert.ok(
    PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS < PROPOSER_UNREACHABLE_TTL_MS,
    "fast timeout < TTL",
  )
  assert.ok(
    PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS < NO_PROGRESS_TIMEOUT_MS,
    "fast timeout < slow timeout",
  )
  assert.ok(
    PROPOSER_UNREACHABLE_TTL_MS <= NO_PROGRESS_TIMEOUT_MS,
    "TTL <= slow timeout",
  )
})
