import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import type { IpfsBlock, CidString } from "./ipfs-types.ts"

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
    const cid = "QmRemoteOnly1" as CidString
    const remoteBytes = Buffer.from("fetched from peer")
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
    const cid = "QmRemoteWithOnPut" as CidString
    const remoteBytes = Buffer.from("from peer")
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
    store.setHooks({ fetchRemote: async () => { fetchCalls++; return Buffer.from("x") } })
    store.setHooks({ onPut: () => { putCalls++ } })
    await store.get("QmMerge" as CidString) // triggers fetch → put
    assert.equal(fetchCalls, 1)
    assert.equal(putCalls, 1)
  })
})
