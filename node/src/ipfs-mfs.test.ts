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

test("#555: mkdir error names the missing intermediate, not the existing parent", async () => {
  // Pre-fix the throw interpolated `parent` (the existing ancestor we
  // just walked into) instead of `current` (the missing path the walker
  // just discovered). `mkdir /no_such_parent_a/sub_b` reported "parent
  // directory not found: /" — but / exists. Operators read that as "root
  // is gone." Same wording-drift family as #543/#545.
  const { mfs, cleanup } = await createMfs()
  try {
    // Top-level missing parent — error must name /no_such_a, not /
    await assert.rejects(
      () => mfs.mkdir("/no_such_a/sub_b"),
      /parent directory not found: \/no_such_a$/,
      "missing top-level parent must be named, not /",
    )
    // Deep missing parent — must name /existing/no_such_b (the
    // missing intermediate), not /existing.
    await mfs.mkdir("/existing")
    await assert.rejects(
      () => mfs.mkdir("/existing/no_such_b/sub_c"),
      /parent directory not found: \/existing\/no_such_b$/,
      "deep missing parent must be named, not its existing ancestor",
    )
    // Sanity: mkdir --parents still works (no regression on the path
    // that bypasses the throw).
    await mfs.mkdir("/par_ok/sub", { parents: true })
    const stat = await mfs.stat("/par_ok/sub")
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

test("#477: cp/mv same source-and-dest must reject when source is missing", async () => {
  // Pre-fix the same-path no-op short-circuit fired before source-
  // existence validation, so `cp /missing /missing` and `mv /missing
  // /missing` silently returned ok:true even though no file existed.
  // Live testnet 88780 reproduction:
  //   curl POST /api/v0/files/cp?arg=/nonexistent&arg=/nonexistent
  //   pre-fix: {"ok":true}    (no file created, no error)
  //   post-fix: {"error":"...","message":"source not found: /nonexistent"}
  // POSIX cp/mv + kubo go-ipfs-mfs both error here. The silent success
  // masked client bugs where dest computation collapsed to src.
  const { mfs, cleanup } = await createMfs()
  try {
    await assert.rejects(
      () => mfs.cp("/missing-cp-target", "/missing-cp-target"),
      /source not found/i,
      "cp must reject missing source even when src == dst",
    )
    await assert.rejects(
      () => mfs.mv("/missing-mv-target", "/missing-mv-target"),
      /source not found/i,
      "mv must reject missing source even when src == dst",
    )

    // Sanity: same-path on an existing file is still a no-op (not an error).
    await mfs.write("/keep.txt", new TextEncoder().encode("data"), { create: true })
    await mfs.cp("/keep.txt", "/keep.txt")    // no-op, no throw
    await mfs.mv("/keep.txt", "/keep.txt")    // no-op, no throw
    const after = await mfs.read("/keep.txt")
    assert.strictEqual(new TextDecoder().decode(after), "data", "same-path op on existing file preserves contents")
  } finally {
    cleanup()
  }
})

test("#539: cp / mv reject when destination already exists (kubo parity, data-loss prevention)", async () => {
  // Live testnet 88780 reproduction (pre-fix):
  //   echo "AAA" > /src.txt; echo "BBB" > /dst.txt; mv /src.txt /dst.txt
  //   curl /files/read?arg=/dst.txt → "AAA"   // BBB silently lost
  //
  // Pre-fix `mfs.mv` and `mfs.cp` did `destParent.entries.set(destBase, ...)`
  // without checking whether the destination already existed. Any pre-
  // existing file at that path was silently clobbered. This is a
  // data-loss bug — a user moving a file to what they think is a new
  // location can accidentally overwrite something at that path with no
  // warning.
  //
  // Kubo: `files cp` and `files mv` both error when destination exists.
  // Per kubo docs: "If the destination already exists, then the command
  // fails." Match that contract so existing-destination clobbering is
  // surfaced as an actionable error instead of silent data loss.
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.write("/src.txt", new TextEncoder().encode("AAA"), { create: true })
    await mfs.write("/dst.txt", new TextEncoder().encode("BBB"), { create: true })

    // (a) cp into existing dest must reject; dest content preserved.
    await assert.rejects(
      () => mfs.cp("/src.txt", "/dst.txt"),
      /destination already exists/i,
      "cp must reject existing destination (data-loss prevention)",
    )
    const afterCp = await mfs.read("/dst.txt")
    assert.strictEqual(new TextDecoder().decode(afterCp), "BBB",
      "dst.txt content preserved after rejected cp")

    // (b) mv into existing dest must reject; both src and dest preserved.
    await assert.rejects(
      () => mfs.mv("/src.txt", "/dst.txt"),
      /destination already exists/i,
      "mv must reject existing destination",
    )
    const srcAfter = await mfs.read("/src.txt")
    const dstAfter = await mfs.read("/dst.txt")
    assert.strictEqual(new TextDecoder().decode(srcAfter), "AAA",
      "src.txt preserved after rejected mv (NOT atomically removed despite the failed move)")
    assert.strictEqual(new TextDecoder().decode(dstAfter), "BBB",
      "dst.txt content preserved after rejected mv")

    // (c) Sanity: cp / mv to a fresh path still work.
    await mfs.cp("/src.txt", "/copy.txt")    // works
    const copy = await mfs.read("/copy.txt")
    assert.strictEqual(new TextDecoder().decode(copy), "AAA", "fresh-dest cp still works")
    await mfs.mv("/copy.txt", "/moved.txt")   // works
    const moved = await mfs.read("/moved.txt")
    assert.strictEqual(new TextDecoder().decode(moved), "AAA", "fresh-dest mv still works")
    await assert.rejects(() => mfs.read("/copy.txt"), /not found/i, "moved-from path is gone")
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

test("#434: stat on directory returns non-empty CID + cumulativeSize, matches flush()", async () => {
  // Pre-fix stat() hard-coded hash:"" and cumulativeSize:0 for every directory.
  // Kubo's files/stat returns the dir's content-addressed CID and a non-zero
  // cumulative size for non-empty dirs — clients (and our own ls vs stat
  // consumers) rely on the CID being present to chase the DAG. Pin both fields.
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/d")
    await mfs.write("/d/a.txt", new TextEncoder().encode("hello"), { create: true })
    await mfs.write("/d/b.txt", new TextEncoder().encode("world!"), { create: true })

    const stat = await mfs.stat("/d")
    assert.strictEqual(stat.type, "directory")
    assert.ok(stat.hash && stat.hash.length > 0, `directory stat must return a non-empty CID, got ${JSON.stringify(stat)}`)
    assert.strictEqual(stat.cumulativeSize, 5 + 6, "cumulativeSize must sum immediate-child sizes (5 + 6 = 11)")
    assert.strictEqual(stat.blocks, 2, "blocks must reflect entry count")

    // stat() and flush() must agree on the same CID for the same dir.
    const flushed = await mfs.flush("/d")
    assert.strictEqual(stat.hash, flushed, "stat() and flush() must return the same CID")
  } finally {
    cleanup()
  }
})

test("#434: stat on empty directory returns non-empty CID + zero cumulativeSize", async () => {
  const { mfs, cleanup } = await createMfs()
  try {
    await mfs.mkdir("/empty")
    const stat = await mfs.stat("/empty")
    assert.strictEqual(stat.type, "directory")
    assert.ok(stat.hash && stat.hash.length > 0, "empty directory must still get a CID (empty-listing CID)")
    assert.strictEqual(stat.cumulativeSize, 0)
    assert.strictEqual(stat.blocks, 0)
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

test("#418: MFS whitespace-only path components rejected (no silent garbage in namespace)", async () => {
  // Sibling of #380 (empty arg). Pre-fix `arg=%20` (single space),
  // `arg=%09` (tab), `arg=%20%20%20` (multi-space) sailed through
  // normalizePath and downstream mkdir/write created files/dirs named
  // " ", "\t", "   " — silent garbage indistinguishable from a real
  // empty-name component. Reject so client typos surface.
  const { mfs, cleanup } = await createMfs()
  try {
    const whitespaceProbes = [" ", "\t", "   ", "/\t", "/ ", "/path/ /sub", "/path/\t/sub"]
    for (const path of whitespaceProbes) {
      await assert.rejects(
        () => mfs.mkdir(path),
        /path component cannot be whitespace-only/i,
        `mkdir ${JSON.stringify(path)} must reject whitespace-only component`,
      )
    }
    // Sanity: paths with non-whitespace components containing internal
    // whitespace are still allowed (e.g. "/my dir" — space inside name).
    await mfs.mkdir("/my dir")
    const entries = await mfs.ls("/")
    assert.ok(entries.some((e) => e.name === "my dir"),
      "internal-whitespace name still allowed")
  } finally {
    cleanup()
  }
})
