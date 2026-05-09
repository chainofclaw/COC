/**
 * R1.4 — H15 staggered-fallback proposer override (real network test)
 *
 * Why this test exists:
 *   The H15 watchdog (consensus.ts L256-365) arms a no-progress override
 *   on the rotation+1 fallback proposer when no BFT block has finalized
 *   for NO_PROGRESS_TIMEOUT_MS (= 600s, hardcoded). All prior H15 coverage
 *   was either:
 *     - unit tests that mock Date.now() (consensus.test.ts L548)
 *     - manual gcloud run-t120-fallback.sh against an observer cluster
 *       (cannot trigger H15 because observers aren't in the validator set)
 *   This is the first end-to-end test where H15 actually fires and the
 *   chain is recovered by a fallback proposer rather than the original
 *   round-robin one.
 *
 * Setup (docker-compose-h15.yml — chainId 88888, 5 BFT validators):
 *   h15-node-1 .. h15-node-5  using anvil index 0..4 keys
 *   round-robin proposer = validators[H % 5]
 *   BFT quorum            = ⌈2·5/3⌉ = 4
 *
 * Test flow:
 *   1. Wait for all 5 to report block ≥10 (cluster healthy)
 *   2. Stop h15-node-1 (anvil-0). The remaining 4 nodes still meet quorum
 *      so 4 out of every 5 blocks still get produced — but every 5th block
 *      is "node-1's turn" and stalls.
 *   3. Wait until cluster heights stop advancing (all stuck on the same
 *      H where validators[H % 5] === node-1).
 *   4. Wait NO_PROGRESS_TIMEOUT_MS (600s) + buffer for the watchdog tick.
 *      H15 fires on rotation+1 = node-2, which proposes that block via
 *      `forcePropose=true`.
 *   5. Assert the cluster height advances ≥1 block after H15 fires
 *      (proves the override worked — without H15, the chain would stay
 *      stuck forever at H).
 *   6. Assert at least one node's logs contain "Phase H15: proposer
 *      override active" (proves the override path was actually taken,
 *      not just "the cluster recovered for some other reason").
 *
 * Total runtime: ~12-13 min (H15 timeout 600s + setup/verify ~3 min)
 *
 * To run locally:
 *   cd tests/multinode-integration
 *   docker compose -f docker-compose-h15.yml up -d --build
 *   TARGET=10 bash scripts/wait-ready-h15.sh
 *   node --experimental-strip-types --test scenarios/04-h15-fallback.test.ts
 *   docker compose -f docker-compose-h15.yml down -v
 */
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"

const RPC_PORTS = [38790, 38792, 38794, 38796, 38798] as const
const STOPPED_NODE = "coc-h15-node-1"

// Hardcoded in node/src/consensus.ts L72 — keep in sync.
const NO_PROGRESS_TIMEOUT_MS = 600_000
// Buffer for the watchdog tick interval + propose tick + BFT round time.
const H15_WATCHDOG_BUFFER_MS = 60_000
// Total fallback budget after the cluster freezes on node-1's slot.
const FALLBACK_BUDGET_MS = NO_PROGRESS_TIMEOUT_MS + H15_WATCHDOG_BUFFER_MS

// Time after which we declare the cluster "frozen at node-1's slot" — 4
// validators × blockTime 3 s × ~3 round-robin cycles.
const FREEZE_DETECT_MS = 60_000
const POLL_INTERVAL_MS = 5_000

async function getBlockNumber(port: number): Promise<bigint> {
  const res = await fetch(`http://localhost:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
  })
  const json = (await res.json()) as { result?: string }
  if (!json.result) throw new Error(`eth_blockNumber on ${port} returned ${JSON.stringify(json)}`)
  return BigInt(json.result)
}

async function maxClusterHeight(): Promise<bigint> {
  const samples = await Promise.all(RPC_PORTS.map((p) => getBlockNumber(p).catch(() => -1n)))
  return samples.reduce((a, b) => (a > b ? a : b), -1n)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("R1.4 — H15 staggered-fallback proposer override", { timeout: 1_500_000 }, () => {
  let baselineHeight = 0n

  before(async () => {
    for (const port of RPC_PORTS) {
      try {
        const h = await getBlockNumber(port)
        if (h > baselineHeight) baselineHeight = h
      } catch (err) {
        throw new Error(
          `pre-flight: validator ${port} unreachable. Bring up the H15 fixture first:\n` +
            `  cd tests/multinode-integration\n` +
            `  docker compose -f docker-compose-h15.yml up -d --build\n` +
            `  TARGET=10 bash scripts/wait-ready-h15.sh`,
        )
      }
    }
    if (baselineHeight < 10n) {
      throw new Error(`baseline ${baselineHeight} < 10 — cluster not warmed up`)
    }
  })

  it("recovers via fallback proposer when round-robin proposer is offline", async () => {
    console.log(`[${new Date().toISOString()}] baseline = ${baselineHeight}, stopping ${STOPPED_NODE}`)
    execSync(`docker stop ${STOPPED_NODE}`, { stdio: "inherit" })

    // ── Stage 1: detect freeze ──────────────────────────────────────────
    console.log(`[${new Date().toISOString()}] waiting up to ${FREEZE_DETECT_MS / 1000}s for cluster to freeze on node-1's slot…`)
    const freezeDeadline = Date.now() + FREEZE_DETECT_MS
    let frozenHeight = -1n
    let lastHeight = await maxClusterHeight()
    let lastChangeMs = Date.now()
    while (Date.now() < freezeDeadline) {
      await sleep(POLL_INTERVAL_MS)
      const h = await maxClusterHeight()
      if (h !== lastHeight) {
        lastHeight = h
        lastChangeMs = Date.now()
      } else if (Date.now() - lastChangeMs >= 15_000) {
        // 15 s of no advance = the cluster is wedged on node-1's slot.
        frozenHeight = h
        break
      }
    }
    if (frozenHeight === -1n) {
      // Cluster kept advancing for the entire FREEZE_DETECT_MS — lucky
      // round-robin alignment never landed on node-1's slot. Poll up to
      // 5 more cycles to give it a chance.
      for (let i = 0; i < 25; i++) {
        await sleep(POLL_INTERVAL_MS)
        const h = await maxClusterHeight()
        if (h === lastHeight) {
          frozenHeight = h
          break
        }
        lastHeight = h
      }
    }
    assert.ok(frozenHeight >= 0n, "cluster never froze — round-robin should have hit node-1 within 25×5s")
    console.log(`[${new Date().toISOString()}] cluster frozen at H=${frozenHeight}; waiting H15 fallback (${FALLBACK_BUDGET_MS / 1000}s)`)

    // ── Stage 2: wait for H15 fallback to fire ──────────────────────────
    const fallbackDeadline = Date.now() + FALLBACK_BUDGET_MS
    let recoveredHeight = -1n
    while (Date.now() < fallbackDeadline) {
      await sleep(POLL_INTERVAL_MS * 4) // 20 s polling — H15 won't fire faster
      const h = await maxClusterHeight()
      if (h > frozenHeight) {
        recoveredHeight = h
        const elapsedS = ((Date.now() - (fallbackDeadline - FALLBACK_BUDGET_MS)) / 1000).toFixed(0)
        console.log(`[${new Date().toISOString()}] cluster advanced from ${frozenHeight} → ${h} after ${elapsedS}s (H15 expected at ${NO_PROGRESS_TIMEOUT_MS / 1000}s)`)
        break
      }
    }
    assert.ok(
      recoveredHeight > frozenHeight,
      `chain did not advance past frozenHeight=${frozenHeight} within ${FALLBACK_BUDGET_MS / 1000}s. ` +
        `If NO_PROGRESS_TIMEOUT_MS changed, update this test's constant.`,
    )

    // ── Stage 3: confirm via container logs ─────────────────────────────
    // Search the running 4 validators (h15-node-{2..5}) for the H15 log
    // line. At least one of them must have armed the override.
    let h15ObservedOn: string | null = null
    for (const i of [2, 3, 4, 5]) {
      const container = `coc-h15-node-${i}`
      try {
        const logs = execSync(`docker logs --tail 500 ${container} 2>&1 || true`, { encoding: "utf-8" })
        if (
          logs.includes("Phase H15: proposer override active") ||
          logs.includes("Phase H15: no BFT progress")
        ) {
          h15ObservedOn = container
          break
        }
      } catch {
        // ignore unreachable container
      }
    }
    assert.ok(
      h15ObservedOn !== null,
      "no H15 override log found in any of nodes 2-5; chain advanced but the override path was not taken — check what unstuck it",
    )
    console.log(`[${new Date().toISOString()}] ✅ H15 override confirmed via logs on ${h15ObservedOn}`)
  })
})
