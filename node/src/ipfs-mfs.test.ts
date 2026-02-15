/**
 * IPFS MFS tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { IpfsMfs } from "./ipfs-mfs.ts"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function createMfs(): Promise<{ mfs: IpfsMfs; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "coc-mfs-"))
  const store = new IpfsBlockstore(dir)
  await store.init()
  const unixfs = new UnixFsBuilder(store)
  const mfs = new IpfsMfs(store, unixfs)
  return { mfs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("MFS: mkdir creates directory", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/testdir")
    const entries = await mfs.ls("/")
    assert.ok(entries.some((e) => e.name === "testdir"))
    assert.strictEqual(entries[0].type, "directory")
  } finally {
    cleanup()
  }
})

test("MFS: mkdir with parents", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/a/b/c", { parents: true })
    const stat = await mfs.stat("/a/b/c")
    assert.strictEqual(stat.type, "directory")
  } finally {
    cleanup()
  }
})

test("MFS: write and read file", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    const data = new TextEncoder().encode("hello world")
    await mfs.write("/test.txt", data, { create: true, parents: true })
    const read = await mfs.read("/test.txt")
    assert.strictEqual(new TextDecoder().decode(read), "hello world")
  } finally {
    cleanup()
  }
})

test("MFS: write fails without create flag", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    const data = new TextEncoder().encode("hello")
    await assert.rejects(
      () => mfs.write("/nonexistent.txt", data),
      /file not found/,
    )
  } finally {
    cleanup()
  }
})

test("MFS: ls lists directory entries", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/mydir")
    await mfs.write("/mydir/a.txt", new TextEncoder().encode("a"), { create: true })
    await mfs.write("/mydir/b.txt", new TextEncoder().encode("b"), { create: true })

    const entries = await mfs.ls("/mydir")
    assert.strictEqual(entries.length, 2)
    assert.ok(entries.some((e) => e.name === "a.txt"))
    assert.ok(entries.some((e) => e.name === "b.txt"))
  } finally {
    cleanup()
  }
})

test("MFS: rm removes file", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.write("/test.txt", new TextEncoder().encode("data"), { create: true })
    await mfs.rm("/test.txt")

    await assert.rejects(() => mfs.read("/test.txt"), /not found/)
  } finally {
    cleanup()
  }
})

test("MFS: rm directory requires recursive flag", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/dir")
    await mfs.write("/dir/file.txt", new TextEncoder().encode("data"), { create: true })

    await assert.rejects(() => mfs.rm("/dir"), /directory not empty/)

    // With recursive flag, should succeed
    await mfs.rm("/dir", { recursive: true })
    const entries = await mfs.ls("/")
    assert.strictEqual(entries.length, 0)
  } finally {
    cleanup()
  }
})

test("MFS: mv moves file", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.write("/old.txt", new TextEncoder().encode("data"), { create: true })
    await mfs.mv("/old.txt", "/new.txt")

    const data = await mfs.read("/new.txt")
    assert.strictEqual(new TextDecoder().decode(data), "data")

    await assert.rejects(() => mfs.read("/old.txt"), /not found/)
  } finally {
    cleanup()
  }
})

test("MFS: cp copies file", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.write("/orig.txt", new TextEncoder().encode("data"), { create: true })
    await mfs.cp("/orig.txt", "/copy.txt")

    const orig = await mfs.read("/orig.txt")
    const copy = await mfs.read("/copy.txt")
    assert.strictEqual(new TextDecoder().decode(orig), "data")
    assert.strictEqual(new TextDecoder().decode(copy), "data")
  } finally {
    cleanup()
  }
})

test("MFS: stat returns file info", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    const data = new TextEncoder().encode("hello world")
    await mfs.write("/test.txt", data, { create: true })

    const stat = await mfs.stat("/test.txt")
    assert.strictEqual(stat.type, "file")
    assert.strictEqual(stat.size, 11)
    assert.ok(stat.hash)
  } finally {
    cleanup()
  }
})

test("MFS: stat returns directory info", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/mydir")
    const stat = await mfs.stat("/mydir")
    assert.strictEqual(stat.type, "directory")
  } finally {
    cleanup()
  }
})

test("MFS: flush returns CID", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.write("/test.txt", new TextEncoder().encode("data"), { create: true })
    const cid = await mfs.flush("/test.txt")
    assert.ok(cid)
    assert.ok(typeof cid === "string")
  } finally {
    cleanup()
  }
})

test("MFS: cannot remove root directory", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await assert.rejects(() => mfs.rm("/"), /cannot remove root/)
  } finally {
    cleanup()
  }
})
