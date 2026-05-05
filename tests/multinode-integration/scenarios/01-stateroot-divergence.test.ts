/**
 * Phase J3 scenario 01 — stateRoot divergence + auto-recovery.
 *
 * Reproduces the 2026-05-05 production stall:
 *   1. Cluster running healthy (block heights advancing in lockstep).
 *   2. Inject leveldb header-stateRoot corruption into node-1 at height H.
 *   3. node-1 restarts; chain engine rejects subsequent block proposals
 *      with stateRoot mismatch.
 *   4. WITHOUT J1.1/J1.3: node-1 never starts a BFT round (proposals
 *      rejected before round starts), no prepareVotes accumulate, H4
 *      detect-on-timeout sees nothing → no snap-sync trigger → stall.
 *   5. WITH J1.1/J1.3: J1.2 callback OR J1.1 buffered-prepare detect
 *      fires onPeerQuorumDiverged → consensus.requestSyncNow → node-1
 *      snap-syncs from peers → chain advances.
 *
 * Acceptance: chain height advances ≥3 blocks within 60s of corruption
 * injection (recovery budget).
 *
 * IMPORTANT: this test requires docker-compose stack to be running.
 * Run via:
 *   cd tests/multinode-integration && docker compose up -d
 *   ./scripts/wait-ready.sh
 *   node --experimental-strip-types --test scenarios/01-stateroot-divergence.test.ts
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"

const RPC_PORTS = [38780, 38782, 38784] as const
const RECOVERY_BUDGET_MS = 60_000
const POLL_INTERVAL_MS = 2_000

interface BlockInfo {
  number: bigint
  hash: string
  stateRoot: string | null
}

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

async function getBlock(port: number, height: bigint): Promise<BlockInfo | null> {
  const res = await fetch(`http://localhost:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getBlockByNumber",
      params: [`0x${height.toString(16)}`, false],
      id: 1,
    }),
  })
  const json = await res.json() as { result?: { number: string; hash: string; stateRoot: string } }
  if (!json.result) return null
  return {
    number: BigInt(json.result.number),
    hash: json.result.hash,
    stateRoot: json.result.stateRoot,
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("J3.01 — stateRoot divergence auto-recovery", () => {
  let baselineHeight = 0n

  before(async () => {
    // Verify all 3 validators are reachable + reporting consistent height
    for (const port of RPC_PORTS) {
      try {
        const h = await getBlockNumber(port)
        if (h > baselineHeight) baselineHeight = h
      } catch (err) {
        throw new Error(`pre-flight: validator ${port} unreachable — bring up docker compose first. Error: ${err}`)
      }
    }
    if (baselineHeight < 3n) {
      throw new Error(`pre-flight: cluster height ${baselineHeight} is too low for fault injection (need ≥3)`)
    }
  })

  it("recovers chain advancement after stateRoot corruption on node-1", async () => {
    const corruptionHeight = baselineHeight - 1n
    console.log(`baseline height = ${baselineHeight}, corrupting at ${corruptionHeight}`)

    // Inject the fault. inject-stateroot-corruption.sh stops the container,
    // overwrites the leveldb stateRoot field, and restarts.
    execSync(
      `bash ${import.meta.dirname}/../scripts/inject-stateroot-corruption.sh coc-mn-node-1 ${corruptionHeight}`,
      { stdio: "inherit" },
    )

    // Wait for node-1 to come back online + then race recovery against budget.
    let recoveryDeadline = Date.now() + RECOVERY_BUDGET_MS
    let initialPostInjectHeight: bigint | null = null

    // Sample initial height after restart (could be < baseline if node-1
    // is mid snap-sync, that's the recovery path we're testing).
    while (Date.now() < recoveryDeadline) {
      try {
        initialPostInjectHeight = await getBlockNumber(RPC_PORTS[0])
        break
      } catch {
        await sleep(1000)
      }
    }
    assert.ok(initialPostInjectHeight !== null, "node-1 RPC never became responsive")
    console.log(`node-1 post-inject height = ${initialPostInjectHeight}`)

    // Now poll all 3 nodes; expect chain to advance ≥3 blocks within budget.
    recoveryDeadline = Date.now() + RECOVERY_BUDGET_MS
    let recovered = false
    let lastSample: bigint[] = []
    while (Date.now() < recoveryDeadline) {
      const samples = await Promise.all(RPC_PORTS.map((p) => getBlockNumber(p).catch(() => -1n)))
      lastSample = samples
      const minHeight = samples.reduce((a, b) => (a < b ? a : b), samples[0])
      if (minHeight >= initialPostInjectHeight + 3n) {
        recovered = true
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }

    assert.ok(
      recovered,
      `chain did not advance ≥3 blocks within ${RECOVERY_BUDGET_MS}ms of corruption. ` +
      `Initial post-inject: ${initialPostInjectHeight}, last sample: ${lastSample.join(",")}`,
    )
    console.log(`recovered: heights = ${lastSample.join(",")}`)

    // Verify all 3 nodes converge on the same stateRoot at the post-recovery height
    const tipHeight = lastSample.reduce((a, b) => (a < b ? a : b), lastSample[0])
    const blocks = await Promise.all(RPC_PORTS.map((p) => getBlock(p, tipHeight)))
    const roots = new Set(blocks.map((b) => b?.stateRoot ?? "<null>"))
    assert.equal(roots.size, 1, `post-recovery stateRoot divergence at ${tipHeight}: ${[...roots].join(" vs ")}`)
  })

  after(() => {
    // Leave the cluster up so subsequent scenarios can run; teardown is
    // the harness operator's responsibility (docker compose down -v).
  })
})
