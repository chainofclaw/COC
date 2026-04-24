import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "../../node/src/ipfs-blockstore.ts"
import { UnixFsBuilder } from "../../node/src/ipfs-unixfs.ts"
import { CidRegistryReader, makeCidRegistryEventReader, type DhtLike, type CidRegistryContractLike } from "./cid-registry-reader.ts"

// Phase C2.2 reader tests. The CidRegistryReader has two responsibilities:
// 1. refresh() loads a pool of CIDs from whatever contract source is
//    injected (real ethers.js contract in prod, canned list in tests).
// 2. pickRandomChallengeTarget picks one, skips CIDs with zero providers
//    or that the local blockstore can't resolve, caches Merkle metadata,
//    and returns something the challenger can lock into a query spec.

let tmpDir: string
let store: IpfsBlockstore
let builder: UnixFsBuilder

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cidreg-"))
  store = new IpfsBlockstore(tmpDir)
  builder = new UnixFsBuilder(store)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function seqRng(values: number[]): () => number {
  // Deterministic RNG that cycles through the provided sequence.
  // Lets tests control shuffle + chunkIndex picks exactly.
  let i = 0
  return () => values[i++ % values.length]
}

function mkDhtWithProviders(map: Record<string, string[]>): DhtLike {
  return {
    findProviders(cid: string, _maxK?: number): string[] {
      return map[cid] ?? []
    },
  }
}

describe("CidRegistryReader", () => {
  it("refresh loads unique CIDs from the contract reader", async () => {
    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({}),
      contractReader: async () => ["cidA", "cidB", "cidA"], // duplicate filtered
    })
    await reader.refresh()
    assert.equal(reader.size(), 2)
  })

  it("pickRandomChallengeTarget returns null when pool is empty", async () => {
    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({}),
      contractReader: async () => [],
    })
    await reader.refresh()
    const target = await reader.pickRandomChallengeTarget()
    assert.equal(target, null)
  })

  it("pickRandomChallengeTarget returns a usable target when CID has providers + bytes", async () => {
    // Create a real file in the blockstore so resolveChunks can walk the DAG.
    const data = new TextEncoder().encode("c2.2 target content")
    const meta = await builder.addFile("t.txt", data, 5)
    assert.ok(meta.leaves.length > 1, "test needs multi-chunk file")

    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({ [meta.cid]: ["peer-a", "peer-b"] }),
      contractReader: async () => [meta.cid],
      // chunkIndex picker: always return index 1
      rng: seqRng([0, 1 / meta.leaves.length]),
    })
    await reader.refresh()
    const target = await reader.pickRandomChallengeTarget()
    assert.ok(target)
    assert.equal(target!.cid, meta.cid)
    assert.equal(target!.merkleRoot, meta.merkleRoot)
    assert.equal(target!.chunkCount, meta.leaves.length)
    assert.ok(target!.chunkIndex >= 0 && target!.chunkIndex < meta.leaves.length)
    assert.ok(target!.chunkSize > 0)
  })

  it("skips CIDs with zero providers and picks the next viable one", async () => {
    const data = new TextEncoder().encode("has providers")
    const meta = await builder.addFile("ok.txt", data)

    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({
        // monopoly CID gets zero providers; real one has peer-z
        "squatted": [],
        [meta.cid]: ["peer-z"],
      }),
      contractReader: async () => ["squatted", meta.cid],
      // force the shuffle so "squatted" is tried first
      rng: seqRng([0.99, 0.0, 0.0, 0.0, 0.0]),
    })
    await reader.refresh()
    const target = await reader.pickRandomChallengeTarget()
    assert.ok(target)
    assert.equal(target!.cid, meta.cid)
  })

  it("skips CIDs whose blockstore resolution fails (file not actually present)", async () => {
    const data = new TextEncoder().encode("has bytes")
    const meta = await builder.addFile("real.txt", data)

    // A CID that DHT claims has providers but is missing from our
    // blockstore and has no remote fallback wired → should be skipped
    // without aborting the picker.
    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({
        "bafyNoBytesHere": ["peer-a"],
        [meta.cid]: ["peer-a"],
      }),
      contractReader: async () => ["bafyNoBytesHere", meta.cid],
      rng: seqRng([0.99, 0.0, 0.0, 0.0, 0.0]),
    })
    await reader.refresh()
    const target = await reader.pickRandomChallengeTarget()
    assert.ok(target, "should have fallen through to the real CID")
    assert.equal(target!.cid, meta.cid)
  })

  it("returns null when every candidate within maxPickRetries is filtered", async () => {
    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({}), // every CID is squatted
      contractReader: async () => ["a", "b", "c", "d", "e"],
      maxPickRetries: 3,
    })
    await reader.refresh()
    const target = await reader.pickRandomChallengeTarget()
    assert.equal(target, null)
  })

  it("caches file meta: repeated picks of same CID don't re-scan DAG", async () => {
    const data = new TextEncoder().encode("cache me ".repeat(20))
    const meta = await builder.addFile("c.txt", data, 8)

    // Poke the blockstore get() counter via a hook that counts calls.
    let getCalls = 0
    const originalGet = store.get.bind(store)
    store.get = async (cid) => {
      getCalls++
      return originalGet(cid)
    }

    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({ [meta.cid]: ["peer-a"] }),
      contractReader: async () => [meta.cid],
    })
    await reader.refresh()
    await reader.pickRandomChallengeTarget()
    const firstCount = getCalls
    assert.ok(firstCount > 0, "first pick scans the DAG")

    await reader.pickRandomChallengeTarget()
    assert.equal(getCalls, firstCount, "second pick hits the cache, no extra blockstore reads")
  })

  it("accepts async findProviders (HTTP-proxy style DHT)", async () => {
    const data = new TextEncoder().encode("async dht")
    const meta = await builder.addFile("a.txt", data)

    const dhtAsync: DhtLike = {
      findProviders: async (cid) => {
        await new Promise((r) => setTimeout(r, 1))
        return cid === meta.cid ? ["peer-a"] : []
      },
    }
    const reader = new CidRegistryReader({
      blockstore: store,
      dht: dhtAsync,
      contractReader: async () => [meta.cid],
    })
    await reader.refresh()
    const target = await reader.pickRandomChallengeTarget()
    assert.ok(target)
    assert.equal(target!.cid, meta.cid)
  })

  it("refresh swallows contractReader errors and keeps prior pool intact", async () => {
    let callCount = 0
    const reader = new CidRegistryReader({
      blockstore: store,
      dht: mkDhtWithProviders({}),
      contractReader: async () => {
        callCount++
        if (callCount === 1) return ["a", "b"]
        throw new Error("RPC down")
      },
    })
    await reader.refresh()
    assert.equal(reader.size(), 2)
    await reader.refresh() // second call throws internally but is caught
    assert.equal(reader.size(), 2, "keep prior pool on refresh failure")
  })
})

describe("makeCidRegistryEventReader", () => {
  it("extracts CID strings from v6 ethers args object format", async () => {
    const fake: CidRegistryContractLike = {
      filters: { CidRegistered: () => ({}) },
      queryFilter: async () => [
        { args: { cidHash: "0x1", cid: "Qm1" } },
        { args: { cidHash: "0x2", cid: "Qm2" } },
      ],
    }
    const read = makeCidRegistryEventReader(fake)
    const cids = await read()
    assert.deepEqual(cids, ["Qm1", "Qm2"])
  })

  it("extracts CID strings from v5 ethers args array format", async () => {
    const fake: CidRegistryContractLike = {
      filters: { CidRegistered: () => ({}) },
      queryFilter: async () => [
        { args: ["0x1", "Qm1", "0xaaaa"] as unknown[] },
        { args: ["0x2", "Qm2", "0xbbbb"] as unknown[] },
      ],
    }
    const read = makeCidRegistryEventReader(fake)
    const cids = await read()
    assert.deepEqual(cids, ["Qm1", "Qm2"])
  })

  it("ignores malformed events without throwing", async () => {
    const fake: CidRegistryContractLike = {
      filters: { CidRegistered: () => ({}) },
      queryFilter: async () => [
        {}, // no args
        { args: { cid: "QmValid" } },
        { args: { wrong: "field" } },
        { args: [42, "QmAlsoValid"] as unknown[] },
      ],
    }
    const read = makeCidRegistryEventReader(fake)
    const cids = await read()
    assert.deepEqual(cids, ["QmValid", "QmAlsoValid"])
  })
})
