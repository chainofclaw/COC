/**
 * Phase J3 scenario 02 — stuck proposer self-clear via H15b watchdog.
 *
 * Reproduces the 2026-05-05 testnet "self-stuck proposer" pattern: node-2
 * was the proposer for height H, formed an internal BFT round, but no peer
 * prepares ever reached its coordinator. The round state pinned at
 * prepareVotes=1 (self only), commitVotes=0, and the H15b stagger
 * watchdog (designed for "all 3 nodes equivocating") didn't apply because
 * stuckProposerId === self → early return. Required `docker restart` to
 * recover.
 *
 * J2.2 fix: when stuckProposerId === self AND active round exists AND
 * elapsed > NO_PROGRESS_TIMEOUT_MS (120s default), the watchdog calls
 * bft.forceClearRound() so the next propose tick can start fresh.
 *
 * Acceptance: chain height advances ≥3 blocks within 4 minutes (≤2 ×
 * NO_PROGRESS_TIMEOUT_MS) of the fault injection ending.
 */
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"

const RPC_PORTS = [38780, 38782, 38784] as const
const PARTITION_DURATION_S = 180
const RECOVERY_BUDGET_MS = 4 * 60_000
const POLL_INTERVAL_MS = 5_000

async function getBlockNumber(port: number): Promise<bigint> {
  const res = await fetch(`http://localhost:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
  })
  const json = await res.json() as { result?: string }
  if (!json.result) throw new Error(`eth_blockNumber on ${port} returned ${JSON.stringify(json)}`)
  return BigInt(json.result)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("J3.02 — stuck proposer self-clear", () => {
  let baselineHeight = 0n

  before(async () => {
    for (const port of RPC_PORTS) {
      try {
        const h = await getBlockNumber(port)
        if (h > baselineHeight) baselineHeight = h
      } catch (err) {
        throw new Error(`pre-flight: validator ${port} unreachable — bring up docker compose first. Error: ${err}`)
      }
    }
  })

  it("recovers chain after proposer's BFT round is partition-induced-stuck", async () => {
    console.log(`baseline height = ${baselineHeight}, partitioning node-2 for ${PARTITION_DURATION_S}s`)

    // Disconnect node-2 from the bridge network. While disconnected:
    //   - node-2 will rotate to be proposer at some height N (round-robin)
    //   - node-2 starts a round, votes prepare, but peers' votes never arrive
    //   - node-1 + node-3 see node-2 as gone, no quorum → stalled at height N-1
    // After reconnect:
    //   - WITHOUT J2.2: node-2's prior round still active, peer prepares for
    //     height N go to its buffer but its own vote remains alone in the
    //     active round — strict 3/3 stalls until docker restart.
    //   - WITH J2.2: ≥120s after partition ends, the noProgressWatchdog tick
    //     observes stuckProposer=self + activeRound=true + elapsed>threshold
    //     → forceClearRound → next tick re-proposes → quorum forms.
    execSync(
      `bash ${import.meta.dirname}/../scripts/freeze-bft-output.sh coc-mn-node-2 ${PARTITION_DURATION_S}`,
      { stdio: "inherit" },
    )

    // Capture height immediately after partition ends.
    const postPartitionHeights = await Promise.all(RPC_PORTS.map((p) => getBlockNumber(p).catch(() => -1n)))
    const minPost = postPartitionHeights.reduce((a, b) => (a < b ? a : b), postPartitionHeights[0])
    console.log(`post-partition heights = ${postPartitionHeights.join(",")}, min = ${minPost}`)

    // Recovery budget: chain advances ≥3 blocks across all nodes.
    const deadline = Date.now() + RECOVERY_BUDGET_MS
    let recovered = false
    let lastSample: bigint[] = []
    while (Date.now() < deadline) {
      const samples = await Promise.all(RPC_PORTS.map((p) => getBlockNumber(p).catch(() => -1n)))
      lastSample = samples
      const minHeight = samples.reduce((a, b) => (a < b ? a : b), samples[0])
      if (minHeight >= minPost + 3n) {
        recovered = true
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }

    assert.ok(
      recovered,
      `chain did not advance ≥3 blocks within ${RECOVERY_BUDGET_MS}ms after partition. ` +
      `Post-partition min: ${minPost}, last sample: ${lastSample.join(",")}`,
    )
    console.log(`recovered: heights = ${lastSample.join(",")}`)
  })
})
