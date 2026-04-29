import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder, storeRawBlock, loadRawBlock, resolveChunks } from "./ipfs-unixfs.ts"
import { hashLeaf, buildMerkleRoot } from "./ipfs-merkle.ts"

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

describe("resolveChunks (Phase C2.1)", () => {
  it("yields one chunk for a small inline-data file", async () => {
    const data = new TextEncoder().encode("inline")
    const meta = await builder.addFile("small.txt", data)
    const collected: Array<{ index: number; bytes: Uint8Array }> = []
    for await (const chunk of resolveChunks(store, meta.cid)) {
      collected.push({ index: chunk.index, bytes: new Uint8Array(chunk.bytes) })
    }
    assert.equal(collected.length, meta.leaves.length)
    const concatenated = Buffer.concat(collected.map((c) => Buffer.from(c.bytes)))
    assert.deepEqual(new Uint8Array(concatenated), data)
  })

  it("yields multiple chunks in original order for multi-chunk file", async () => {
    const data = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz0123456789")
    const meta = await builder.addFile("multi.txt", data, 10)
    assert.ok(meta.leaves.length > 1, "test needs > 1 chunk to be meaningful")

    const collected: Array<{ index: number; bytes: Uint8Array }> = []
    for await (const chunk of resolveChunks(store, meta.cid)) {
      collected.push({ index: chunk.index, bytes: new Uint8Array(chunk.bytes) })
    }
    // Indexes are 0..N-1 in order.
    assert.deepEqual(collected.map((c) => c.index), collected.map((_, i) => i))
    // Concatenation round-trips to the original input.
    const joined = Buffer.concat(collected.map((c) => Buffer.from(c.bytes)))
    assert.deepEqual(new Uint8Array(joined), data)
  })

  it("chunks are individually hashable and match the file meta leaves", async () => {
    const data = new TextEncoder().encode("merkle-target content for phase C2.1 proof")
    const meta = await builder.addFile("proof.txt", data, 8)
    assert.ok(meta.merkleLeaves.length > 1)

    const hashes: string[] = []
    for await (const chunk of resolveChunks(store, meta.cid)) {
      hashes.push(hashLeaf(chunk.bytes))
    }
    // Live-derived leaf hashes must match what UnixFsBuilder stamped
    // into the meta — content-addressed both ways.
    assert.deepEqual(hashes, meta.merkleLeaves)
    assert.equal(buildMerkleRoot(hashes), meta.merkleRoot)
  })

  it("callers can break early without resolving all chunks", async () => {
    const data = new TextEncoder().encode("a".repeat(100))
    const meta = await builder.addFile("break.txt", data, 5) // 20 chunks

    let count = 0
    for await (const _chunk of resolveChunks(store, meta.cid)) {
      count++
      if (count === 3) break
    }
    assert.equal(count, 3, "for-await break must stop the generator early")
  })

  it("throws when the cid does not exist in the store", async () => {
    await assert.rejects(
      async () => {
        for await (const _ of resolveChunks(store, "bafyNotPresent" as any)) { /* drain */ }
      },
      // Plain blockstore error from missing CID file.
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
  })

  it("works through the blockstore fetchRemote fallback (C1.3 chaining)", async () => {
    // Set up a "source" store with the file, then a fresh "mirror" store
    // that can only reach the source via fetchRemote. resolveChunks
    // should still yield the full file by cascading through the
    // blockstore's fallback mechanism one chunk at a time.
    const data = new TextEncoder().encode("cascading fetch target data")
    const sourceMeta = await builder.addFile("cascade.txt", data, 8)

    const mirrorDir = await mkdtemp(join(tmpdir(), "unixfs-mirror-"))
    try {
      const mirror = new IpfsBlockstore(mirrorDir)
      mirror.setHooks({
        fetchRemote: async (cid) => {
          try {
            const b = await store.get(cid)
            return b.bytes
          } catch {
            return null
          }
        },
      })

      const collected: Uint8Array[] = []
      for await (const chunk of resolveChunks(mirror, sourceMeta.cid)) {
        collected.push(new Uint8Array(chunk.bytes))
      }
      const joined = Buffer.concat(collected.map((c) => Buffer.from(c)))
      assert.deepEqual(new Uint8Array(joined), data)
    } finally {
      await rm(mirrorDir, { recursive: true, force: true })
    }
  })
})
