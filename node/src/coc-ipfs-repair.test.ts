/**
 * Phase C3.3 — IPFS repair loop tests.
 *
 * Exercises the `IpfsRepairLoop.runOnce()` semantics in isolation from
 * the timer and the real DHT/blockstore/push stack. Uses lightweight
 * mocks so failure modes (missing bytes, pushToK throws, DHT empty)
 * are deterministic.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { IpfsRepairLoop } from "./coc-ipfs-repair.ts"
import type { PushToKResult } from "./coc-ipfs-wiring.ts"
import type { CidString } from "./ipfs-types.ts"

type ProviderMap = Map<string, string[]>
type BlockstoreMap = Map<string, Uint8Array>

// Minimal fakes: just enough surface area for the loop.
function mkDht(providers: ProviderMap): { findProviders: (cid: string, maxK?: number) => string[] } {
  return {
    findProviders: (cid: string, maxK = 3) => {
      const list = providers.get(cid) ?? []
      return list.slice(0, maxK)
    },
  }
}

function mkBlockstore(blocks: BlockstoreMap): {
  listPins: () => Promise<CidString[]>
  get: (cid: CidString) => Promise<{ cid: CidString; bytes: Uint8Array }>
} {
  return {
    listPins: async () => [...blocks.keys()] as CidString[],
    get: async (cid: CidString) => {
      const bytes = blocks.get(cid)
      if (!bytes) throw new Error(`missing block ${cid}`)
      return { cid, bytes }
    },
  }
}

function mkPushToK(opts?: {
  perCidResult?: (cid: string) => Partial<PushToKResult>
  throws?: (cid: string) => boolean
}): {
  calls: string[]
  pushToK: (cid: string, bytes: Uint8Array) => Promise<PushToKResult>
} {
  const calls: string[] = []
  const pushToK = async (cid: string, bytes: Uint8Array): Promise<PushToKResult> => {
    calls.push(cid)
    if (opts?.throws?.(cid)) throw new Error("push failed")
    const base: PushToKResult = {
      cid,
      attempted: 3,
      succeeded: ["peer-a", "peer-b", "peer-c"],
      failed: [],
      skippedLowPeers: false,
    }
    const over = opts?.perCidResult?.(cid) ?? {}
    return { ...base, ...over }
  }
  return { calls, pushToK }
}

describe("IpfsRepairLoop", () => {
  it("identifies under-replicated CIDs and calls pushToK for each", async () => {
    const providers: ProviderMap = new Map([
      ["cid-a", ["peer-x"]], // 1 provider: under-replicated
      ["cid-b", ["peer-x", "peer-y"]], // 2 providers: at floor, skipped
      ["cid-c", []], // 0 providers: under-replicated
    ])
    const blocks: BlockstoreMap = new Map([
      ["cid-a", Buffer.from("A")],
      ["cid-b", Buffer.from("B")],
      ["cid-c", Buffer.from("C")],
    ])
    const { calls, pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    const metrics = await loop.runOnce()
    assert.deepEqual(calls.sort(), ["cid-a", "cid-c"])
    assert.equal(metrics.cidsInspected, 3)
    assert.equal(metrics.underReplicatedFound, 2)
    assert.equal(metrics.repairsAttempted, 2)
    assert.equal(metrics.repairsSucceeded, 2)
    assert.equal(metrics.repairsFailed, 0)
  })

  it("is a no-op when every CID is already replicated to minReplicas", async () => {
    const providers: ProviderMap = new Map([
      ["cid-a", ["peer-x", "peer-y"]],
      ["cid-b", ["peer-x", "peer-y", "peer-z"]],
    ])
    const blocks: BlockstoreMap = new Map([
      ["cid-a", Buffer.from("A")],
      ["cid-b", Buffer.from("B")],
    ])
    const { calls, pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    const metrics = await loop.runOnce()
    assert.equal(calls.length, 0, "no repair calls for fully-replicated set")
    assert.equal(metrics.underReplicatedFound, 0)
    assert.equal(metrics.repairsAttempted, 0)
  })

  it("caps repairs per tick at repairBatchSize", async () => {
    // 10 CIDs, all under-replicated; batch size = 3 → only 3 repairs.
    const providers: ProviderMap = new Map()
    const blocks: BlockstoreMap = new Map()
    for (let i = 0; i < 10; i++) {
      providers.set(`cid-${i}`, []) // 0 providers
      blocks.set(`cid-${i}`, Buffer.from([i]))
    }
    const { calls, pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
      repairBatchSize: 3,
    })
    const metrics = await loop.runOnce()
    assert.equal(calls.length, 3, "batch cap limits repairs")
    assert.equal(metrics.underReplicatedFound, 10, "all 10 marked as under-replicated")
    assert.equal(metrics.repairsAttempted, 3)
  })

  it("counts a pushToK throw as a failed repair and continues with the rest", async () => {
    const providers: ProviderMap = new Map([
      ["cid-good", []],
      ["cid-bad", []],
    ])
    const blocks: BlockstoreMap = new Map([
      ["cid-good", Buffer.from("G")],
      ["cid-bad", Buffer.from("B")],
    ])
    const { calls, pushToK } = mkPushToK({
      throws: (cid) => cid === "cid-bad",
    })
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    const metrics = await loop.runOnce()
    assert.equal(calls.length, 2, "both CIDs were attempted despite one throw")
    assert.equal(metrics.repairsSucceeded, 1)
    assert.equal(metrics.repairsFailed, 1)
  })

  it("counts a pushToK that returned zero successes as failed", async () => {
    const providers: ProviderMap = new Map([["cid-x", []]])
    const blocks: BlockstoreMap = new Map([["cid-x", Buffer.from("X")]])
    const { pushToK } = mkPushToK({
      perCidResult: () => ({ succeeded: [], failed: ["p1", "p2"], skippedLowPeers: false }),
    })
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    const metrics = await loop.runOnce()
    assert.equal(metrics.repairsAttempted, 1)
    assert.equal(metrics.repairsFailed, 1)
    assert.equal(metrics.repairsSucceeded, 0)
  })

  it("guards against overlapping runs (reentrance)", async () => {
    const providers: ProviderMap = new Map([["cid-a", []]])
    const blocks: BlockstoreMap = new Map([["cid-a", Buffer.from("A")]])
    let pushInFlight = 0
    let maxInFlight = 0
    const pushToK = async (cid: string): Promise<PushToKResult> => {
      pushInFlight++
      maxInFlight = Math.max(maxInFlight, pushInFlight)
      await new Promise((r) => setTimeout(r, 50))
      pushInFlight--
      return {
        cid, attempted: 3, succeeded: ["peer-a"], failed: [], skippedLowPeers: false,
      }
    }
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    // Fire two ticks nearly simultaneously; second one should bail
    // out at the reentrance guard instead of double-pushing.
    const [m1, m2] = await Promise.all([loop.runOnce(), loop.runOnce()])
    assert.equal(maxInFlight, 1, "reentrance guard prevented overlap")
    assert.ok(m1.repairsAttempted + m2.repairsAttempted <= 1, "at most one push fired across both ticks")
  })

  it("runOnce after stop() is a no-op", async () => {
    const providers: ProviderMap = new Map([["cid-a", []]])
    const blocks: BlockstoreMap = new Map([["cid-a", Buffer.from("A")]])
    const { calls, pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    loop.stop()
    const metrics = await loop.runOnce()
    assert.equal(calls.length, 0)
    assert.equal(metrics.ticks, 0, "no tick counted after stop")
  })

  it("timer-driven start() fires runOnce periodically", async () => {
    const providers: ProviderMap = new Map([["cid-a", []]])
    const blocks: BlockstoreMap = new Map([["cid-a", Buffer.from("A")]])
    const { calls, pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkBlockstore(blocks),
      dht: mkDht(providers),
      pushToK,
      tickIntervalMs: 30,
      minReplicas: 2,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100))
    loop.stop()
    // At 30ms cadence in 100ms we expect 2-3 ticks; each fires one
    // repair since the single CID stays under-replicated (the mock DHT
    // is static). Assert we got at least one push and the timer fired.
    assert.ok(calls.length >= 1, `expected >= 1 tick, got ${calls.length}`)
    assert.ok(loop.getMetrics().ticks >= 1, "metrics.ticks incremented")
  })

  it("skips a CID whose bytes are missing without aborting the tick", async () => {
    const providers: ProviderMap = new Map([
      ["cid-missing", []],
      ["cid-present", []],
    ])
    // `cid-missing` is in the pin list but NOT in the blockstore map
    // — simulates a partial pin/unpin race or disk corruption.
    const blocks: BlockstoreMap = new Map([
      ["cid-missing", undefined as unknown as Uint8Array],
      ["cid-present", Buffer.from("P")],
    ])
    // Strip the undefined so get() throws for cid-missing.
    blocks.delete("cid-missing")
    // But still list it as pinned.
    const bs = {
      listPins: async () => ["cid-missing", "cid-present"] as CidString[],
      get: async (cid: CidString) => {
        const bytes = blocks.get(cid)
        if (!bytes) throw new Error(`missing ${cid}`)
        return { cid, bytes }
      },
    }
    const { calls, pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: bs,
      dht: mkDht(providers),
      pushToK,
      minReplicas: 2,
    })
    const metrics = await loop.runOnce()
    assert.deepEqual(calls, ["cid-present"], "missing CID skipped, present one repaired")
    assert.equal(metrics.repairsSucceeded, 1)
    assert.equal(metrics.repairsFailed, 1, "missing CID counted as failed")
  })
})
