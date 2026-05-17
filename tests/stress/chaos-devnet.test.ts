/**
 * Consensus chaos test against a real process devnet.
 *
 * Replaces the deprecated docker-compose multinode chaos scenarios. Drives a
 * genuine BFT cluster spawned by scripts/start-devnet.sh and injects faults
 * via scripts/{stop,start}-devnet-node.sh (single-node stop/restart, leveldb +
 * config preserved). Covers: liveness under one fault, validator rejoin/catch-
 * up, rolling restart, and the N=5 fault boundary (two down breaches 3f+1).
 *
 * Opt-in — spawns N node processes (~minutes). Skips unless COC_CHAOS_DEVNET=1.
 *
 * Run: COC_CHAOS_DEVNET=1 node --experimental-strip-types --test tests/stress/chaos-devnet.test.ts
 */
import { describe, it, before, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { tryGetHead, rpcResult } from "../../scripts/lib/rpc-helper.ts"

const ENABLED = process.env.COC_CHAOS_DEVNET === "1"
const NODES = Number(process.env.COC_CHAOS_NODES ?? 5)
const BASE_RPC = 28780
const REPO = new URL("../..", import.meta.url).pathname

const rpcUrl = (id: number) => `http://127.0.0.1:${BASE_RPC + (id - 1)}`

function sh(script: string, args: string[], timeoutMs = 120_000): void {
  execFileSync("bash", [`scripts/${script}`, ...args], {
    cwd: REPO,
    stdio: "pipe",
    timeout: timeoutMs,
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Highest head across all reachable nodes; -1 if none reachable. */
async function clusterHead(): Promise<number> {
  const heads = await Promise.all(
    Array.from({ length: NODES }, (_, i) => tryGetHead(rpcUrl(i + 1))),
  )
  const live = heads.filter((h): h is number => h !== null)
  return live.length ? Math.max(...live) : -1
}

/** Poll `id` until its head climbs by >= minDelta, or the deadline passes. */
async function waitHeadAdvance(id: number, from: number, minDelta: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = from
  while (Date.now() < deadline) {
    const h = await tryGetHead(rpcUrl(id))
    if (h !== null) {
      last = h
      if (h - from >= minDelta) return h
    }
    await sleep(2000)
  }
  return last
}

/** Wait until node `id` has caught up to within 2 blocks of the cluster head. */
async function waitRejoin(id: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const mine = await tryGetHead(rpcUrl(id))
    const cluster = await clusterHead()
    if (mine !== null && cluster >= 0 && mine >= cluster - 2) return
    await sleep(2000)
  }
}

/**
 * Restart any unreachable node and wait until the whole cluster is reachable
 * and roughly in sync. Keeps each chaos scenario independent — a scenario that
 * aborts mid-fault must not leave a node down for the next one.
 */
async function ensureClusterUp(): Promise<void> {
  for (let id = 1; id <= NODES; id++) {
    if ((await tryGetHead(rpcUrl(id))) === null) {
      try {
        sh("start-devnet-node.sh", [String(NODES), String(id)])
      } catch {
        /* node may already be restarting — recheck below */
      }
    }
  }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const heads = await Promise.all(
      Array.from({ length: NODES }, (_, i) => tryGetHead(rpcUrl(i + 1))),
    )
    if (heads.every((h): h is number => h !== null)) {
      const max = Math.max(...(heads as number[]))
      const min = Math.min(...(heads as number[]))
      if (max - min <= 3) return
    }
    await sleep(2000)
  }
}

describe("consensus chaos (process devnet)", { skip: !ENABLED ? "set COC_CHAOS_DEVNET=1 to run" : false }, () => {
  before(() => {
    // start-devnet.sh blocks until every node is ready (or fails loudly).
    sh("start-devnet.sh", [String(NODES)], 180_000)
  })

  // Each scenario starts from a whole, in-sync cluster so an aborted fault
  // never cascades into the next test.
  beforeEach(ensureClusterUp)

  after(() => {
    try {
      sh("stop-devnet.sh", [String(NODES)], 60_000)
    } catch {
      /* best-effort teardown */
    }
  })

  it("baseline: every validator advances and stays in consensus", async () => {
    const start = await clusterHead()
    assert.ok(start >= 0, "cluster reachable at start")
    const after = await waitHeadAdvance(1, start, 3, 30_000)
    assert.ok(after - start >= 3, `head advanced from ${start} to ${after}`)

    // No fork: every node reports the same stateRoot for a settled block.
    const settled = `0x${(after - 2).toString(16)}`
    const roots = await Promise.all(
      Array.from({ length: NODES }, async (_, i) => {
        const b = await rpcResult<{ stateRoot: string }>(rpcUrl(i + 1), "eth_getBlockByNumber", [settled, false])
        return b.stateRoot
      }),
    )
    assert.equal(new Set(roots).size, 1, `all ${NODES} nodes agree on stateRoot @${settled}`)
  })

  it("single validator down — chain stays live, rejoins and catches up on restart", async () => {
    const before = await clusterHead()
    sh("stop-devnet-node.sh", [String(NODES), String(NODES)]) // drop the last validator

    // N-1 validators still meet the 3f+1 quorum — chain must keep producing.
    const live = await waitHeadAdvance(1, before, 3, 40_000)
    assert.ok(live - before >= 3, `chain advanced with one validator down (${before} -> ${live})`)

    // Restart it; it must rejoin and catch up to the cluster head.
    sh("start-devnet-node.sh", [String(NODES), String(NODES)])
    const target = await clusterHead()
    const rejoined = await waitHeadAdvance(NODES, 0, target, 90_000)
    assert.ok(rejoined >= target - 2, `restarted validator caught up (${rejoined} vs cluster ${target})`)
  })

  it("rolling restart — no stall while never more than one validator is down", async () => {
    let head = await clusterHead()
    for (let id = 2; id <= NODES; id++) {
      sh("stop-devnet-node.sh", [String(NODES), String(id)])
      const duringDown = await waitHeadAdvance(1, head, 2, 40_000)
      assert.ok(duringDown - head >= 2, `chain live while node-${id} down (${head} -> ${duringDown})`)
      sh("start-devnet-node.sh", [String(NODES), String(id)])
      await waitRejoin(id, 90_000) // it must fully rejoin before the next node drops
      head = await clusterHead()
    }
    const final = await waitHeadAdvance(1, head, 3, 40_000)
    assert.ok(final - head >= 3, "chain healthy after the full rolling restart")
  })

  it("dual validator down breaches the N=5 fault bound — chain stalls, recovers on restore", async () => {
    assert.equal(NODES, 5, "fault-boundary scenario is calibrated for N=5")
    const before = await clusterHead()
    sh("stop-devnet-node.sh", [String(NODES), "4"])
    sh("stop-devnet-node.sh", [String(NODES), "5"])

    // 3 of 5 < ceil(2*5/3)=4 quorum — consensus cannot finalize.
    const stalled = await waitHeadAdvance(1, before, 8, 25_000)
    assert.ok(stalled - before <= 2, `chain stalled with 2/5 down (delta ${stalled - before})`)

    // Restore one — quorum (4/5) is back, the chain must resume.
    sh("start-devnet-node.sh", [String(NODES), "4"])
    const resumed = await waitHeadAdvance(1, stalled, 3, 60_000)
    assert.ok(resumed - stalled >= 3, `chain resumed after restoring quorum (${stalled} -> ${resumed})`)

    sh("start-devnet-node.sh", [String(NODES), "5"]) // restore full set for teardown
  })
})
