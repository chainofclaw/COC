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

// ---------------------------------------------------------------------------
// Phase Q.5 — erasure manifest repair tick
// ---------------------------------------------------------------------------
import { encodeFile, decodeFile } from "./ipfs-erasure.ts"
import { randomBytes } from "node:crypto"

function mkErasureBlockstore(blocks: BlockstoreMap, pins: Set<string>) {
  return {
    listPins: async () => [...pins] as CidString[],
    get: async (cid: CidString) => {
      const bytes = blocks.get(cid)
      if (!bytes) throw new Error(`missing block ${cid}`)
      return { cid, bytes }
    },
    has: async (cid: CidString) => blocks.has(cid),
    put: async (block: { cid: CidString; bytes: Uint8Array }) => {
      blocks.set(block.cid, block.bytes)
    },
    pin: async (cid: CidString) => {
      pins.add(cid)
    },
  }
}

describe("IpfsRepairLoop Phase Q.5 — erasure repair tick", () => {
  it("reconstructs a missing data shard from parity and re-pins it", async () => {
    // Need distinct shard content so dropping one CID doesn't take out
    // multiple logical shards (see Q.2 dedup note).
    const file = randomBytes(4 * 256 * 1024 + 17)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    for (const block of enc.shardBlocks) {
      blocks.set(block.cid, block.bytes)
      pins.add(block.cid)
    }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    pins.add(enc.manifestCid)

    // Lose one data shard (simulates disk corruption / unpin race).
    const lostCid = enc.manifest.stripes[0].data[1]
    blocks.delete(lostCid)
    pins.delete(lostCid)

    const { pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(new Map()),
      pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasureManifestsScanned, 1)
    assert.equal(metrics.erasureStripesRepaired, 1)
    assert.equal(metrics.erasureShardsReconstructed, 1)
    assert.ok(blocks.has(lostCid), "lost shard restored locally")
    assert.ok(pins.has(lostCid), "lost shard re-pinned")

    // Sanity: full file decodes back successfully.
    const back = await decodeFile(enc.manifest, async (c) => blocks.get(c) ?? null)
    assert.equal(back.byteLength, file.byteLength)
    assert.ok(Buffer.from(back).equals(Buffer.from(file)))
  })

  it("regenerates a missing parity shard when all data is intact", async () => {
    const file = randomBytes(4 * 256 * 1024 + 7)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    for (const block of enc.shardBlocks) {
      blocks.set(block.cid, block.bytes)
      pins.add(block.cid)
    }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    pins.add(enc.manifestCid)

    const lostParity = enc.manifest.stripes[0].parity[0]
    blocks.delete(lostParity)
    pins.delete(lostParity)

    const { pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(new Map()),
      pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasureStripesRepaired, 1)
    assert.equal(metrics.erasureShardsReconstructed, 1)
    assert.ok(blocks.has(lostParity), "parity shard regenerated")
    assert.ok(pins.has(lostParity), "parity shard re-pinned")
  })

  it("skips a stripe with M+1 missing shards and bumps the insufficient counter", async () => {
    const file = randomBytes(4 * 256 * 1024 + 21)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    for (const block of enc.shardBlocks) {
      blocks.set(block.cid, block.bytes)
      pins.add(block.cid)
    }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    pins.add(enc.manifestCid)

    // Drop 3 distinct shards in one stripe — can't recover (need ≥4 of 6).
    blocks.delete(enc.manifest.stripes[0].data[0])
    blocks.delete(enc.manifest.stripes[0].data[1])
    blocks.delete(enc.manifest.stripes[0].data[2])

    const { pushToK } = mkPushToK()
    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(new Map()),
      pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasureStripesSkippedInsufficient, 1)
    assert.equal(metrics.erasureStripesRepaired, 0)
    assert.ok(!blocks.has(enc.manifest.stripes[0].data[0]), "lost shard not restored")
  })

  it("intact manifest is a no-op", async () => {
    const file = randomBytes(2 * 256 * 1024)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    for (const block of enc.shardBlocks) { blocks.set(block.cid, block.bytes); pins.add(block.cid) }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes); pins.add(enc.manifestCid)

    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(new Map()),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()
    assert.equal(metrics.erasureManifestsScanned, 1)
    assert.equal(metrics.erasureStripesRepaired, 0)
    assert.equal(metrics.erasureShardsReconstructed, 0)
  })

  it("reconstructs across multiple stripes per tick", async () => {
    const file = randomBytes(3 * 4 * 256 * 1024 + 11) // 3 stripes
    const enc = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(enc.manifest.stripes.length, 4) // padding bumps to 4
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    for (const block of enc.shardBlocks) { blocks.set(block.cid, block.bytes); pins.add(block.cid) }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes); pins.add(enc.manifestCid)

    // Lose one data shard from each of two different stripes.
    const lost1 = enc.manifest.stripes[1].data[2]
    const lost2 = enc.manifest.stripes[2].parity[0]
    blocks.delete(lost1)
    blocks.delete(lost2)

    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(new Map()),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()
    assert.equal(metrics.erasureStripesRepaired, 2)
    assert.equal(metrics.erasureShardsReconstructed, 2)
    assert.ok(blocks.has(lost1))
    assert.ok(blocks.has(lost2))
  })

  it("erasure tick runs even when no CIDs are under-replicated (regression)", async () => {
    // Reported during Q.5 testnet validation: when every pin's DHT
    // provider count meets the floor, runOnce() used to return early
    // before runErasureTick. This test pins all shards as fully-
    // replicated (3 providers each) but locally deletes one — the
    // erasure tick must still fire and reconstruct from parity.
    const file = randomBytes(4 * 256 * 1024 + 5)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    const providers: ProviderMap = new Map()
    for (const block of enc.shardBlocks) {
      blocks.set(block.cid, block.bytes)
      pins.add(block.cid)
      providers.set(block.cid, ["peer-x", "peer-y", "peer-z"])
    }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    pins.add(enc.manifestCid)
    providers.set(enc.manifestCid, ["peer-x", "peer-y", "peer-z"])

    const lostCid = enc.manifest.stripes[0].data[0]
    blocks.delete(lostCid)
    // Note: pin still set — local loss simulated, DHT still claims
    // we hold the shard (typical for stale provider records during a
    // brief disk-corruption window).

    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(providers),
      pushToK: mkPushToK().pushToK,
      minReplicas: 2,
    })
    const metrics = await loop.runOnce()
    assert.equal(metrics.underReplicatedFound, 0, "nothing under-replicated")
    assert.equal(metrics.repairsAttempted, 0, "no pushToK fired")
    assert.equal(metrics.erasureManifestsScanned, 1, "manifest still scanned")
    assert.equal(metrics.erasureStripesRepaired, 1, "missing shard reconstructed")
    assert.ok(blocks.has(lostCid), "shard restored locally")
  })

  it("respects erasureManifestBatchSize cap", async () => {
    // Build 5 manifests but only allow 2 per tick.
    const blocks: BlockstoreMap = new Map()
    const pins = new Set<string>()
    const manifestCids: string[] = []
    for (let i = 0; i < 5; i++) {
      const file = randomBytes(4 * 256 * 1024 + i)
      const enc = await encodeFile(file, { n: 4, m: 2 })
      for (const block of enc.shardBlocks) { blocks.set(block.cid, block.bytes); pins.add(block.cid) }
      blocks.set(enc.manifestCid, enc.manifestBlock.bytes); pins.add(enc.manifestCid)
      manifestCids.push(enc.manifestCid)
      // Lose one data shard so each manifest needs repair.
      blocks.delete(enc.manifest.stripes[0].data[1])
    }

    const loop = new IpfsRepairLoop({
      blockstore: mkErasureBlockstore(blocks, pins),
      dht: mkDht(new Map()),
      pushToK: mkPushToK().pushToK,
      erasureManifestBatchSize: 2,
    })
    const metrics = await loop.runOnce()
    assert.equal(metrics.erasureManifestsScanned, 2, "batch cap enforced")
    assert.equal(metrics.erasureStripesRepaired, 2)
  })
})
