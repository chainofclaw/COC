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
})
