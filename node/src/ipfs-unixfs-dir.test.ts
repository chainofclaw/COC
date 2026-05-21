import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { InterfaceBlockstoreAdapter } from "./ipfs-blockstore-adapter.ts"
import { buildDirectoryDag } from "./ipfs-unixfs-dir.ts"

let tmpDir: string
let store: IpfsBlockstore
let adapter: InterfaceBlockstoreAdapter
const enc = (s: string) => new TextEncoder().encode(s)

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "unixfs-dir-"))
  store = new IpfsBlockstore(tmpDir)
  await store.init()
  adapter = new InterfaceBlockstoreAdapter(store)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("buildDirectoryDag", () => {
  it("builds a flat directory with multiple files", async () => {
    const res = await buildDirectoryDag([
      { path: "a.txt", content: enc("alpha") },
      { path: "b.txt", content: enc("beta") },
    ], adapter)
    assert.equal(res.root.type, "directory")
    assert.ok(res.root.cid.startsWith("bafy"))
    const fileNodes = res.all.filter((n) => n.type === "file")
    assert.equal(fileNodes.length, 2)
  })

  it("creates intermediate directories for nested paths", async () => {
    const res = await buildDirectoryDag([
      { path: "docs/a.txt", content: enc("alpha") },
      { path: "docs/img/b.bin", content: enc("BINARY") },
    ], adapter)
    const paths = res.all.map((n) => n.path)
    // Implicit `docs` and `docs/img` directories must be materialised.
    assert.ok(paths.includes("docs"), `expected 'docs' dir, got ${paths}`)
    assert.ok(paths.includes("docs/img"), `expected 'docs/img' dir, got ${paths}`)
    assert.equal(res.root.type, "directory")
  })

  it("is deterministic — same input yields the same root CID", async () => {
    const input = [
      { path: "x", content: enc("one") },
      { path: "y", content: enc("two") },
    ]
    const a = await buildDirectoryDag(input, adapter)
    const b = await buildDirectoryDag(input, new InterfaceBlockstoreAdapter(store))
    assert.equal(a.root.cid, b.root.cid)
  })

  it("handles an empty (explicit) directory entry", async () => {
    const res = await buildDirectoryDag([{ path: "emptydir" }], adapter)
    assert.equal(res.root.type, "directory")
    // The empty directory exists as a link inside the wrapping root even
    // though the importer does not yield it as a separate node.
    const { resolveUnixfsPath } = await import("./ipfs-path-resolve.ts")
    const child = await resolveUnixfsPath(res.root.cid, ["emptydir"], adapter)
    assert.equal(child.type, "directory")
  })

  it("auto-shards a large directory into a HAMT node", async () => {
    // Enough entries with long names to push the directory node past the
    // 256 KiB shard-split threshold → importer emits hamt-sharded-directory.
    const entries = Array.from({ length: 5000 }, (_, i) => ({
      path: `file-with-a-deliberately-long-name-${i}.txt`,
      content: enc(`c${i}`),
    }))
    const res = await buildDirectoryDag(entries, adapter)
    assert.equal(res.root.type, "hamt-sharded-directory",
      `large directory must shard into HAMT, got ${res.root.type}`)
  })
})
