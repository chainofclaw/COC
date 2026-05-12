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

test("#302: mkdir under an existing FILE must reject with 'not a directory'", async () => {
  // Live-reproducible bug on 88780 testnet (probe iteration #37):
  //   POST /api/v0/files/write?arg=/a/file.txt&create=true&parents=true   → 200
  //   POST /api/v0/files/mkdir?arg=/a/file.txt/sub&parents=true           → 200 (BUG)
  //   POST /api/v0/files/ls?arg=/a/file.txt                                → lists `sub` as child
  // Pre-fix mkdir blindly overwrote the file entry in the parent dir
  // with a `type:"directory"` entry, silently orphaning the UnixFS file
  // content, and `this.dirs` and `parent.entries` then disagreed on the
  // type of the same path. POSIX requires ENOTDIR here.
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/a", { parents: true })
    await mfs.write("/a/file.txt", new TextEncoder().encode("hello"), { create: true })

    // KEY invariant 1: mkdir UNDER the file must reject
    await assert.rejects(
      () => mfs.mkdir("/a/file.txt/sub", { parents: true }),
      /not a directory/,
      "mkdir under a file must reject with 'not a directory' (POSIX ENOTDIR)",
    )

    // KEY invariant 2: even mkdir AT the file path must reject (no clobber)
    await assert.rejects(
      () => mfs.mkdir("/a/file.txt", { parents: true }),
      /not a directory/,
      "mkdir at a path that is already a file must reject (no silent overwrite)",
    )

    // KEY invariant 3: the original file's content + listing must be intact
    const lsRoot = await mfs.ls("/a")
    const fileEntry = lsRoot.find((e: { name: string; type: string }) => e.name === "file.txt")
    assert.ok(fileEntry, "file entry must still exist after rejected mkdir")
    assert.strictEqual(fileEntry!.type, "file", "entry type must still be 'file', not 'directory'")
    const stat = await mfs.stat("/a/file.txt")
    assert.strictEqual(stat.type, "file", "stat must report 'file' for the rejected-mkdir path")

    // KEY invariant 4: write through a file-as-parent must reject too,
    // since write uses mkdir({parents:true}) under the hood.
    await assert.rejects(
      () => mfs.write("/a/file.txt/nested", new Uint8Array([1, 2, 3]), { create: true, parents: true }),
      /not a directory/,
      "write with parents:true through a file path must reject — write goes through mkdir",
    )
  } finally {
    cleanup()
  }
})

test("#302: mkdir at root depth with file collision still rejects", async () => {
  // Same family, top-level path. Confirms the check fires on the FIRST
  // component too (not just intermediates), so a flat /root.txt + mkdir
  // /root.txt is not a regression case.
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.write("/root.txt", new TextEncoder().encode("x"), { create: true })
    await assert.rejects(
      () => mfs.mkdir("/root.txt", { parents: true }),
      /not a directory/,
    )
    await assert.rejects(
      () => mfs.mkdir("/root.txt/x", { parents: true }),
      /not a directory/,
    )
  } finally {
    cleanup()
  }
})
