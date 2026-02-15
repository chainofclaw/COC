import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder, storeRawBlock, loadRawBlock } from "./ipfs-unixfs.ts"

let tmpDir: string
let store: IpfsBlockstore
let builder: UnixFsBuilder

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "unixfs-test-"))
  store = new IpfsBlockstore(tmpDir)
  builder = new UnixFsBuilder(store)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("UnixFsBuilder", () => {
  it("addFile and readFile round-trip for small file", async () => {
    const data = new TextEncoder().encode("hello world")
    const meta = await builder.addFile("test.txt", data)

    assert.ok(meta.cid)
    assert.equal(meta.size, 11)
    assert.ok(meta.leaves.length >= 1)
    assert.ok(meta.merkleRoot)

    const read = await builder.readFile(meta.cid)
    assert.deepEqual(read, data)
  })

  it("addFile and readFile round-trip for multi-chunk file", async () => {
    // Use tiny block size to force multiple chunks
    const data = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz0123456789")
    const meta = await builder.addFile("big.txt", data, 10)

    assert.ok(meta.leaves.length > 1)
    assert.equal(meta.size, data.length)

    const read = await builder.readFile(meta.cid)
    assert.deepEqual(read, data)
  })

  it("addFile handles empty file", async () => {
    const data = new Uint8Array(0)
    const meta = await builder.addFile("empty.txt", data)

    assert.equal(meta.size, 0)
    assert.ok(meta.cid)
  })

  it("getProof returns valid merkle proof", async () => {
    const data = new TextEncoder().encode("proof test data for merkle")
    const meta = await builder.addFile("proof.txt", data, 8)

    assert.ok(meta.merkleLeaves.length > 1)

    const proof = await builder.getProof(meta, 0)
    assert.equal(proof.chunkIndex, 0)
    assert.ok(proof.leafHash)
    assert.equal(proof.merkleRoot, meta.merkleRoot)
    assert.ok(Array.isArray(proof.merklePath))
  })

  it("getProof throws for invalid chunk index", async () => {
    const data = new TextEncoder().encode("test")
    const meta = await builder.addFile("small.txt", data)

    await assert.rejects(
      () => builder.getProof(meta, 999),
      { message: "invalid chunk index" },
    )
  })

  it("produces deterministic CID for same content", async () => {
    const data = new TextEncoder().encode("deterministic")
    const meta1 = await builder.addFile("a.txt", data)
    const meta2 = await builder.addFile("b.txt", data)

    assert.equal(meta1.cid, meta2.cid)
    assert.equal(meta1.merkleRoot, meta2.merkleRoot)
  })
})

describe("storeRawBlock / loadRawBlock", () => {
  it("store and load round-trip", async () => {
    const data = new TextEncoder().encode("raw block content")
    const stored = await storeRawBlock(store, data)

    assert.ok(stored.cid)
    assert.deepEqual(stored.bytes, data)

    const loaded = await loadRawBlock(store, stored.cid)
    assert.deepEqual(new Uint8Array(loaded.bytes), data)
  })

  it("produces CIDv1 with raw codec", async () => {
    const data = new TextEncoder().encode("v1 raw")
    const stored = await storeRawBlock(store, data)
    // CIDv1 starts with "b" (base32)
    assert.ok(stored.cid.startsWith("b"))
  })
})
