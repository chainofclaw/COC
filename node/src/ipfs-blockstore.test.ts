import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { keccak256 } from "ethers"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import type { IpfsBlock, CidString } from "./ipfs-types.ts"

/** Content-addressed CID for `bytes` in the "0x…" keccak256 convention —
 *  what the blockstore's remote-fetch verification accepts. */
function cidFor(bytes: Uint8Array): CidString {
  return keccak256(bytes) as CidString
}

let tmpDir: string
let store: IpfsBlockstore

function makeBlock(cid: string, data: string): IpfsBlock {
  return { cid: cid as CidString, bytes: Buffer.from(data) }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ipfs-test-"))
  store = new IpfsBlockstore(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("IpfsBlockstore", () => {
  it("put and get a block", async () => {
    const block = makeBlock("QmTestCid1", "hello ipfs")
    await store.put(block)
    const retrieved = await store.get("QmTestCid1" as CidString)
    assert.equal(retrieved.cid, "QmTestCid1")
    assert.deepEqual(retrieved.bytes, Buffer.from("hello ipfs"))
  })

  it("has returns true for existing block", async () => {
    const block = makeBlock("QmTestCid2", "data")
    await store.put(block)
    assert.equal(await store.has("QmTestCid2" as CidString), true)
  })

  it("has returns false for missing block", async () => {
    assert.equal(await store.has("QmNonexistent" as CidString), false)
  })

  it("get throws for missing block", async () => {
    await assert.rejects(
      () => store.get("QmMissing" as CidString),
      { code: "ENOENT" },
    )
  })

  it("listBlocks returns stored CIDs", async () => {
    await store.put(makeBlock("QmA", "a"))
    await store.put(makeBlock("QmB", "b"))
    const list = await store.listBlocks()
    assert.equal(list.length, 2)
    assert.ok(list.includes("QmA"))
    assert.ok(list.includes("QmB"))
  })

  it("listBlocks returns empty for fresh store", async () => {
    const list = await store.listBlocks()
    assert.equal(list.length, 0)
  })

  it("pin and listPins", async () => {
    await store.pin("QmPinned1" as CidString)
    await store.pin("QmPinned2" as CidString)
    const pins = await store.listPins()
    assert.equal(pins.length, 2)
    assert.ok(pins.includes("QmPinned1"))
  })

  it("pin deduplicates", async () => {
    await store.pin("QmDup" as CidString)
    await store.pin("QmDup" as CidString)
    const pins = await store.listPins()
    assert.equal(pins.length, 1)
  })

  it("concurrent pins are serialized without ENOENT or lost-updates", async () => {
    // Pre-fix bug: pins.json used a shared `pins.json.tmp` path + no lock,
    // so N parallel pin() calls raced the rename — second rename hit
    // ENOENT, and the read-modify-write window lost some adds.
    const N = 20
    const cids: CidString[] = Array.from({ length: N }, (_, i) => `QmConc${i.toString().padStart(2, "0")}` as CidString)
    const results = await Promise.allSettled(cids.map((c) => store.pin(c)))
    for (const r of results) assert.equal(r.status, "fulfilled", `pin rejected: ${(r as PromiseRejectedResult).reason}`)
    const pins = await store.listPins()
    assert.equal(pins.length, N, "every concurrent pin should be persisted")
    for (const c of cids) assert.ok(pins.includes(c), `missing pin ${c}`)
  })

  it("stat returns correct counts and size", async () => {
    await store.put(makeBlock("QmS1", "abc"))
    await store.put(makeBlock("QmS2", "defgh"))
    await store.pin("QmS1" as CidString)

    const s = await store.stat()
    assert.equal(s.numBlocks, 2)
    assert.equal(s.repoSize, 8) // 3 + 5 bytes
    assert.equal(s.pins, 1)
  })

  it("stat on empty store", async () => {
    const s = await store.stat()
    assert.equal(s.numBlocks, 0)
    assert.equal(s.repoSize, 0)
    assert.equal(s.pins, 0)
  })

  // --- Phase C1.3: fetchRemote fallback path.
  // See plans/coc-evm-abstract-turtle.md §C1.3. Locks in that get()
  // gracefully delegates to the hook on ENOENT and caches the result.

  it("get falls back to fetchRemote when CID is missing locally, caches result", async () => {
    const remoteBytes = Buffer.from("fetched from peer")
    const cid = cidFor(remoteBytes)
    let fetchCalls = 0
    store.setHooks({
      fetchRemote: async (requested) => {
        fetchCalls++
        assert.equal(requested, cid)
        return remoteBytes
      },
    })

    const first = await store.get(cid)
    assert.deepEqual(first.bytes, remoteBytes)
    assert.equal(fetchCalls, 1)

    // Second get should be a local hit — no additional fetch.
    const second = await store.get(cid)
    assert.deepEqual(second.bytes, remoteBytes)
    assert.equal(fetchCalls, 1, "cached locally after first fetch")
  })

  it("get: a remote block that does not hash to the CID is rejected", async () => {
    // Security regression (#658): the pull path (wire-client →
    // requestBlockFromAny → fetchRemote) forwards peer bytes verbatim. A
    // malicious provider serving bytes that do not match the requested CID
    // must not have the forgery returned to the caller, cached to disk, or
    // re-advertised — content addressing has to be enforced on the pull.
    const genuine = Buffer.from("the real content")
    const cid = cidFor(genuine)
    const forged = Buffer.from("attacker-controlled payload")
    let onPutCalls = 0
    store.setHooks({
      fetchRemote: async () => forged, // peer lies about the content
      onPut: () => { onPutCalls++ },
    })

    await assert.rejects(
      () => store.get(cid),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
      "a forged remote block must surface as a miss, not be returned",
    )
    assert.equal(onPutCalls, 0, "a forged block must not be cached")
  })

  it("get returns ENOENT when fetchRemote yields null (no peer had it)", async () => {
    store.setHooks({ fetchRemote: async () => null })
    await assert.rejects(
      () => store.get("QmGhost" as CidString),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
  })

  it("get returns ENOENT when no fetchRemote hook is registered", async () => {
    await assert.rejects(
      () => store.get("QmGhost2" as CidString),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
  })

  it("#8: get({ localOnly: true }) skips fetchRemote even when hook is attached", async () => {
    // SSRF defense: the public read tier must not let an attacker probe
    // unknown CIDs to coerce a DHT findProviders + wire BlockRequest
    // fan-out. localOnly:true means a local miss surfaces ENOENT directly,
    // fetchRemote is bypassed entirely.
    let fetchCalled = false
    store.setHooks({
      fetchRemote: async () => {
        fetchCalled = true
        return Buffer.from("would-be-peer-bytes")
      },
    })
    await assert.rejects(
      () => store.get("QmLocalOnlyMiss" as CidString, { localOnly: true }),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
    assert.equal(fetchCalled, false, "fetchRemote MUST NOT be called when localOnly:true")
  })

  it("#8: get(cid) without opts still triggers fetchRemote (backward-compat)", async () => {
    let fetchCalled = false
    const reply = Buffer.from("peer-served")
    store.setHooks({
      fetchRemote: async () => {
        fetchCalled = true
        return reply
      },
    })
    // Use a CID-shape that matches the bytes so the content-address
    // verification passes; otherwise fetchRemote's reply is dropped and
    // ENOENT surfaces, masking what we're trying to assert.
    const result = await store.get(cidFor(reply))
    assert.equal(fetchCalled, true, "default behaviour must still call fetchRemote")
    assert.deepEqual(Buffer.from(result.bytes), reply)
  })

  it("get: fetchRemote throwing is treated as a miss, original ENOENT surfaces", async () => {
    store.setHooks({
      fetchRemote: async () => { throw new Error("peer RPC exploded") },
    })
    await assert.rejects(
      () => store.get("QmBoom" as CidString),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
  })

  it("get: non-ENOENT errors propagate (fetchRemote is not tried)", async () => {
    let fetchCalled = false
    store.setHooks({
      fetchRemote: async () => { fetchCalled = true; return Buffer.from("x") },
    })
    // Passing an invalid CID → blockPath throws synchronously, not ENOENT.
    await assert.rejects(
      () => store.get("../escape" as CidString),
      /invalid CID/,
    )
    assert.equal(fetchCalled, false, "fetchRemote must NOT be invoked on non-ENOENT errors")
  })

  it("put fires onPut hook with cid + bytes", async () => {
    const received: Array<{ cid: string; len: number }> = []
    store.setHooks({
      onPut: (cid, bytes) => { received.push({ cid, len: bytes.length }) },
    })
    await store.put(makeBlock("QmHooked1", "hello"))
    assert.deepEqual(received, [{ cid: "QmHooked1", len: 5 }])
  })

  it("put succeeds even if onPut throws", async () => {
    store.setHooks({ onPut: () => { throw new Error("announce blew up") } })
    await store.put(makeBlock("QmResilient", "data"))
    // Block must still be retrievable despite the hook throwing.
    const back = await store.get("QmResilient" as CidString)
    assert.equal(back.bytes.toString(), "data")
  })

  it("fetchRemote result is cached via put, so onPut fires for remote fetches too", async () => {
    const remoteBytes = Buffer.from("from peer")
    const cid = cidFor(remoteBytes)
    let onPutCalls = 0
    store.setHooks({
      fetchRemote: async () => remoteBytes,
      onPut: (c) => { if (c === cid) onPutCalls++ },
    })
    await store.get(cid)
    assert.equal(onPutCalls, 1, "onPut fires when caching a remotely fetched block")
  })

  it("setHooks merges partial updates without wiping existing hooks", async () => {
    let fetchCalls = 0
    let putCalls = 0
    const mergeBytes = Buffer.from("x")
    store.setHooks({ fetchRemote: async () => { fetchCalls++; return mergeBytes } })
    store.setHooks({ onPut: () => { putCalls++ } })
    await store.get(cidFor(mergeBytes)) // triggers fetch → put
    assert.equal(fetchCalls, 1)
    assert.equal(putCalls, 1)
  })

  // --- Phase C1.4: source-tagged put hook.

  it("put() tags onPut with source=local by default", async () => {
    const received: Array<{ cid: string; source: string | undefined }> = []
    store.setHooks({
      onPut: (cid, _bytes, opts) => { received.push({ cid, source: opts?.source }) },
    })
    await store.put(makeBlock("QmLocalTag", "x"))
    assert.deepEqual(received, [{ cid: "QmLocalTag", source: "local" }])
  })

  it("putFromPeer tags onPut with source=remote-cache", async () => {
    const received: Array<{ cid: string; source: string | undefined }> = []
    store.setHooks({
      onPut: (cid, _bytes, opts) => { received.push({ cid, source: opts?.source }) },
    })
    await store.putFromPeer(makeBlock("QmPushRecv", "peer-delivered"))
    assert.deepEqual(received, [{ cid: "QmPushRecv", source: "remote-cache" }])
    // Actual bytes persisted identically to a local put.
    const back = await store.get("QmPushRecv" as CidString)
    assert.equal(back.bytes.toString(), "peer-delivered")
  })

  it("fetchRemote cache-back tags onPut with source=remote-cache", async () => {
    const received: Array<{ cid: string; source: string | undefined }> = []
    const peerBytes = Buffer.from("from-peer")
    store.setHooks({
      fetchRemote: async () => peerBytes,
      onPut: (cid, _bytes, opts) => { received.push({ cid, source: opts?.source }) },
    })
    await store.get(cidFor(peerBytes))
    assert.equal(received.length, 1)
    assert.equal(received[0].source, "remote-cache")
  })

  // --- Phase S1: maxBytes + LRU eviction.
  // Light-mode peers cap their blockstore so tmpfs / volume size limits aren't
  // hit by unbounded growth. Pinned CIDs are never evicted.

  it("Phase S1: unbounded by default — no eviction even when many puts", async () => {
    // payload 100 bytes × 5 → 500 bytes total; no cap should keep all.
    for (let i = 0; i < 5; i++) {
      await store.put(makeBlock(`QmU${i}`, "x".repeat(100)))
    }
    const list = await store.listBlocks()
    assert.equal(list.length, 5, "no maxBytes ⇒ no eviction")
  })

  it("Phase S1: maxBytes=N evicts oldest LRU entry on overflow", async () => {
    const cappedStore = new IpfsBlockstore(tmpDir, undefined, { maxBytes: 250 })
    // each block is 100 bytes; cap=250 ⇒ at most 2 stored (90% of 250 = 225, target after evict).
    await cappedStore.put(makeBlock("QmL1", "x".repeat(100))) // total=100
    await cappedStore.put(makeBlock("QmL2", "x".repeat(100))) // total=200
    await cappedStore.put(makeBlock("QmL3", "x".repeat(100))) // total=300 → evict to ≤225 ⇒ drop QmL1
    const has1 = await cappedStore.has("QmL1" as CidString)
    const has2 = await cappedStore.has("QmL2" as CidString)
    const has3 = await cappedStore.has("QmL3" as CidString)
    assert.equal(has1, false, "oldest should be evicted")
    assert.equal(has2, true)
    assert.equal(has3, true)
  })

  it("Phase S1: pinned CIDs are never evicted", async () => {
    const cappedStore = new IpfsBlockstore(tmpDir, undefined, { maxBytes: 250 })
    await cappedStore.put(makeBlock("QmPinMe", "x".repeat(100)))
    await cappedStore.pin("QmPinMe" as CidString)
    await cappedStore.put(makeBlock("QmFiller1", "x".repeat(100)))
    await cappedStore.put(makeBlock("QmFiller2", "x".repeat(100))) // would otherwise evict QmPinMe
    await cappedStore.put(makeBlock("QmFiller3", "x".repeat(100))) // pushes more pressure
    const hasPin = await cappedStore.has("QmPinMe" as CidString)
    assert.equal(hasPin, true, "pinned must survive any number of evictions")
  })

  it("Phase S1: get() updates LRU recency — recently-accessed entries survive", async () => {
    const cappedStore = new IpfsBlockstore(tmpDir, undefined, { maxBytes: 250 })
    await cappedStore.put(makeBlock("QmOld", "x".repeat(100)))
    await cappedStore.put(makeBlock("QmMid", "x".repeat(100)))
    // Touch QmOld so it becomes most-recently-used.
    await cappedStore.get("QmOld" as CidString)
    // Now QmMid is the LRU victim.
    await cappedStore.put(makeBlock("QmNew", "x".repeat(100)))
    assert.equal(await cappedStore.has("QmOld" as CidString), true, "touched entry survives")
    assert.equal(await cappedStore.has("QmMid" as CidString), false, "untouched entry evicted")
    assert.equal(await cappedStore.has("QmNew" as CidString), true)
  })

  it("Phase S1: maxBytes survives restart — re-init reads existing blocks into LRU", async () => {
    const s1 = new IpfsBlockstore(tmpDir, undefined, { maxBytes: 300 })
    await s1.put(makeBlock("QmPersistA", "x".repeat(100)))
    await s1.put(makeBlock("QmPersistB", "x".repeat(100)))
    // Fresh instance pointing at same dir picks up existing on-disk blocks.
    const s2 = new IpfsBlockstore(tmpDir, undefined, { maxBytes: 300 })
    await s2.put(makeBlock("QmPersistC", "x".repeat(100))) // total=300, fits exactly
    await s2.put(makeBlock("QmPersistD", "x".repeat(100))) // overflow → must evict from on-disk inventory
    const list = await s2.listBlocks()
    assert.ok(list.length <= 3, `expected eviction after restart-aware overflow; got ${list.length}`)
  })

  it("#126: unpin removes from pins.json, returns true once, false after", async () => {
    await store.put(makeBlock("QmUnpinA", "x"))
    await store.pin("QmUnpinA" as CidString)
    assert.deepEqual(await store.listPins(), ["QmUnpinA"])
    assert.equal(await store.unpin("QmUnpinA" as CidString), true, "first unpin returns true")
    assert.deepEqual(await store.listPins(), [], "pin removed")
    assert.equal(await store.unpin("QmUnpinA" as CidString), false, "second unpin is idempotent (false)")
    // Block file still on disk — unpin does NOT touch bytes.
    assert.equal(await store.has("QmUnpinA" as CidString), true)
  })

  it("#126: removeBlock evicts both file and pin entry", async () => {
    await store.put(makeBlock("QmRmA", "data"))
    await store.pin("QmRmA" as CidString)
    const result = await store.removeBlock("QmRmA" as CidString)
    assert.deepEqual(result, { removedFile: true, wasPinned: true })
    assert.equal(await store.has("QmRmA" as CidString), false)
    assert.deepEqual(await store.listPins(), [])
    // Second remove is idempotent — neither file nor pin remains.
    const second = await store.removeBlock("QmRmA" as CidString)
    assert.deepEqual(second, { removedFile: false, wasPinned: false })
  })

  it("#126: gc sweeps unpinned blocks, preserves pinned", async () => {
    await store.put(makeBlock("QmPinnedA", "p"))
    await store.put(makeBlock("QmGarbageA", "g"))
    await store.put(makeBlock("QmGarbageB", "g"))
    await store.pin("QmPinnedA" as CidString)
    const removed = await store.gc()
    assert.deepEqual(removed.sort(), ["QmGarbageA", "QmGarbageB"].sort())
    assert.equal(await store.has("QmPinnedA" as CidString), true, "pinned block survives GC")
    assert.equal(await store.has("QmGarbageA" as CidString), false, "unpinned block evicted")
    assert.equal(await store.has("QmGarbageB" as CidString), false, "unpinned block evicted")
    // Second GC is a no-op (everything left is pinned).
    const removedAgain = await store.gc()
    assert.deepEqual(removedAgain, [])
  })
})
