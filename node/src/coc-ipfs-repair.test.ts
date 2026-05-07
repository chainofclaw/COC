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

// ---------------------------------------------------------------------------
// Phase Q+1 — proactive peer-pull during repair tick (issue #69)
// ---------------------------------------------------------------------------

/**
 * Blockstore mock that simulates `fetchRemote` recovery: when a CID is
 * requested via `get()` and is missing locally, the mock checks a
 * "peer pool" for the bytes. If present, it caches them locally
 * (mirroring real `IpfsBlockstore.get`'s behaviour after a successful
 * fetchRemote) and returns them. Otherwise throws ENOENT.
 */
function mkPeerPullBlockstore(
  blocks: BlockstoreMap,
  pins: Set<string>,
  peerPool: BlockstoreMap,
) {
  return {
    listPins: async () => [...pins] as CidString[],
    get: async (cid: CidString) => {
      let bytes = blocks.get(cid)
      if (!bytes) {
        // Simulate fetchRemote: try the peer pool. On hit, cache locally.
        const peerBytes = peerPool.get(cid)
        if (peerBytes) {
          blocks.set(cid, peerBytes)
          bytes = peerBytes
        }
      }
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

describe("IpfsRepairLoop Phase Q+1 — proactive peer-pull", () => {
  // The C3.3 under-replicated push step in `runOnce()` calls
  // `store.get(cid)` for every CID with provider count < minReplicas.
  // In our peer-pull mock that triggers the simulated fetchRemote,
  // caching the shard locally before the Q.5 erasure tick gets a chance
  // to look. To test Q+1's specific contribution, populate the DHT
  // providers map so C3.3 considers every shard well-replicated and
  // skips it — leaving the Q+1 path as the only thing that pulls.
  function fullyReplicatedProviders(cids: string[]): ProviderMap {
    const m: ProviderMap = new Map()
    for (const cid of cids) m.set(cid, ["peer-x", "peer-y", "peer-z"])
    return m
  }

  it("peer-pull restores all missing shards without parity reconstruction", async () => {
    // Local node has 1 of 4 data shards + 0 parity. Peers hold the other 5.
    // Repair tick should peer-pull every missing shard and skip RS entirely.
    // Exactly one stripe — N*shardSize so there's no half-stripe edge case.
    const file = randomBytes(4 * 256 * 1024)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(enc.manifest.stripes.length, 1)
    const blocks: BlockstoreMap = new Map()
    const peerPool: BlockstoreMap = new Map()
    const pins = new Set<string>()

    blocks.set(enc.shardBlocks[0].cid, enc.shardBlocks[0].bytes) // keep data[0] locally
    for (const block of enc.shardBlocks) pins.add(block.cid)
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    pins.add(enc.manifestCid)
    // The other 5 shards live only on peers.
    for (let i = 1; i < enc.shardBlocks.length; i++) {
      peerPool.set(enc.shardBlocks[i].cid, enc.shardBlocks[i].bytes)
    }

    const allCids = [...enc.shardBlocks.map((b) => b.cid), enc.manifestCid]
    const loop = new IpfsRepairLoop({
      blockstore: mkPeerPullBlockstore(blocks, pins, peerPool),
      dht: mkDht(fullyReplicatedProviders(allCids)),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasureManifestsScanned, 1)
    assert.equal(metrics.erasurePeerPullsAttempted, 5, "5 missing shards probed")
    assert.equal(metrics.erasurePeerPullsSucceeded, 5, "all pulled from peers")
    assert.equal(metrics.erasureStripesPeerHealed, 1, "stripe healed via peer-pull alone")
    assert.equal(metrics.erasureStripesSkippedInsufficient, 0, "never declared unrecoverable")
    // RS encoder NOT invoked since pulls covered everything.
    assert.equal(metrics.erasureShardsReconstructed, 5, "shards counted as reconstructed for ops dashboards")

    for (const block of enc.shardBlocks) {
      assert.ok(blocks.has(block.cid), `shard ${block.cid} now local`)
    }
  })

  it("peer-pull + parity reconstruction hybrid: peer-pull restores some, RS fills the rest", async () => {
    // Local has 2 data shards. Peers have 1 data + 1 parity → 4 total
    // available after pull = N. RS reconstructs the remaining 1 data
    // and 1 parity from those 4 sources.
    const file = randomBytes(4 * 256 * 1024)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(enc.manifest.stripes.length, 1)
    const blocks: BlockstoreMap = new Map()
    const peerPool: BlockstoreMap = new Map()
    const pins = new Set<string>()

    // Local: data[0], data[2]
    blocks.set(enc.manifest.stripes[0].data[0], enc.shardBlocks[0].bytes)
    blocks.set(enc.manifest.stripes[0].data[2], enc.shardBlocks[2].bytes)
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    for (const block of enc.shardBlocks) pins.add(block.cid)
    pins.add(enc.manifestCid)
    // Peers: data[1], parity[0]
    peerPool.set(enc.manifest.stripes[0].data[1], enc.shardBlocks[1].bytes)
    peerPool.set(enc.manifest.stripes[0].parity[0], enc.shardBlocks[4].bytes)
    // No source: data[3], parity[1]

    const allCids = [...enc.shardBlocks.map((b) => b.cid), enc.manifestCid]
    const loop = new IpfsRepairLoop({
      blockstore: mkPeerPullBlockstore(blocks, pins, peerPool),
      dht: mkDht(fullyReplicatedProviders(allCids)),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasurePeerPullsAttempted, 4, "4 missing shards probed")
    assert.equal(metrics.erasurePeerPullsSucceeded, 2, "2 found on peers")
    assert.equal(metrics.erasureStripesPeerHealed, 0, "stripe NOT fully peer-healed (peers missing some)")
    assert.equal(metrics.erasureStripesRepaired, 1, "stripe still gets RS reconstruction")
    assert.equal(metrics.erasureStripesSkippedInsufficient, 0, "not unrecoverable — 4 sources after pull = N")

    // Every shard now exists locally (peer pulls + RS regen).
    for (const block of enc.shardBlocks) {
      assert.ok(blocks.has(block.cid), `shard ${block.cid} now local`)
    }
  })

  it("peer-pull cannot help when shards are gone everywhere → unrecoverable", async () => {
    // Local has 2 data shards. Peers have nothing. Total 2 < N=4 → genuinely lost.
    const file = randomBytes(4 * 256 * 1024)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(enc.manifest.stripes.length, 1)
    const blocks: BlockstoreMap = new Map()
    const peerPool: BlockstoreMap = new Map() // empty — no peer holds anything
    const pins = new Set<string>()

    blocks.set(enc.manifest.stripes[0].data[0], enc.shardBlocks[0].bytes)
    blocks.set(enc.manifest.stripes[0].data[1], enc.shardBlocks[1].bytes)
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    for (const block of enc.shardBlocks) pins.add(block.cid)
    pins.add(enc.manifestCid)

    const allCids = [...enc.shardBlocks.map((b) => b.cid), enc.manifestCid]
    const loop = new IpfsRepairLoop({
      blockstore: mkPeerPullBlockstore(blocks, pins, peerPool),
      dht: mkDht(fullyReplicatedProviders(allCids)),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasurePeerPullsAttempted, 4, "tried every missing shard")
    assert.equal(metrics.erasurePeerPullsSucceeded, 0, "no peer had anything")
    assert.equal(metrics.erasureStripesSkippedInsufficient, 1, "correctly declared unrecoverable")
    assert.equal(metrics.erasureStripesRepaired, 0, "no reconstruction possible")
  })

  it("intact local stripe doesn't trigger peer-pull (no work)", async () => {
    const file = randomBytes(4 * 256 * 1024)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    const blocks: BlockstoreMap = new Map()
    const peerPool: BlockstoreMap = new Map()
    const pins = new Set<string>()
    for (const block of enc.shardBlocks) { blocks.set(block.cid, block.bytes); pins.add(block.cid) }
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes); pins.add(enc.manifestCid)

    const allCids = [...enc.shardBlocks.map((b) => b.cid), enc.manifestCid]
    const loop = new IpfsRepairLoop({
      blockstore: mkPeerPullBlockstore(blocks, pins, peerPool),
      dht: mkDht(fullyReplicatedProviders(allCids)),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasureManifestsScanned, 1)
    assert.equal(metrics.erasurePeerPullsAttempted, 0, "no peer-pull when local is full")
    assert.equal(metrics.erasureStripesPeerHealed, 0)
    assert.equal(metrics.erasureStripesRepaired, 0)
  })

  it("regression — Q.5 unrecoverable scenario now resolves via peer-pull", async () => {
    // Reproduces the Q.7 multi-server testnet case: server-1 has 3 of 6
    // shards locally (M+1 missing) and the previous Q.5 tick logged
    // 'unrecoverable' even though peers held the rest. Q+1 tick should
    // now resolve this without any external trigger.
    const file = randomBytes(4 * 256 * 1024)
    const enc = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(enc.manifest.stripes.length, 1)
    const blocks: BlockstoreMap = new Map()
    const peerPool: BlockstoreMap = new Map()
    const pins = new Set<string>()

    // Local: data[0], parity[0], parity[1] — 3 of 6, missing 3 data shards.
    blocks.set(enc.manifest.stripes[0].data[0], enc.shardBlocks[0].bytes)
    blocks.set(enc.manifest.stripes[0].parity[0], enc.shardBlocks[4].bytes)
    blocks.set(enc.manifest.stripes[0].parity[1], enc.shardBlocks[5].bytes)
    blocks.set(enc.manifestCid, enc.manifestBlock.bytes)
    for (const block of enc.shardBlocks) pins.add(block.cid)
    pins.add(enc.manifestCid)

    // Peers hold the missing 3 data shards (typical of pushStripe spread).
    peerPool.set(enc.manifest.stripes[0].data[1], enc.shardBlocks[1].bytes)
    peerPool.set(enc.manifest.stripes[0].data[2], enc.shardBlocks[2].bytes)
    peerPool.set(enc.manifest.stripes[0].data[3], enc.shardBlocks[3].bytes)

    const allCids = [...enc.shardBlocks.map((b) => b.cid), enc.manifestCid]
    const loop = new IpfsRepairLoop({
      blockstore: mkPeerPullBlockstore(blocks, pins, peerPool),
      dht: mkDht(fullyReplicatedProviders(allCids)),
      pushToK: mkPushToK().pushToK,
    })
    const metrics = await loop.runOnce()

    assert.equal(metrics.erasurePeerPullsSucceeded, 3, "all 3 missing data shards pulled from peers")
    assert.equal(metrics.erasureStripesPeerHealed, 1, "stripe fully restored via peer-pull")
    assert.equal(metrics.erasureStripesSkippedInsufficient, 0, "no unrecoverable warning")
  })
})
