import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { InterfaceBlockstoreAdapter } from "./ipfs-blockstore-adapter.ts"
import { buildDirectoryDag } from "./ipfs-unixfs-dir.ts"
import {
  resolveUnixfsPath,
  listDirectory,
  readEntryBytes,
  PathResolveError,
  MAX_PATH_DEPTH,
  isParsableCid,
} from "./ipfs-path-resolve.ts"

let tmpDir: string
let store: IpfsBlockstore
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

function adapter(): InterfaceBlockstoreAdapter {
  return new InterfaceBlockstoreAdapter(store)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "path-resolve-"))
  store = new IpfsBlockstore(tmpDir)
  await store.init()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function sampleTree(): Promise<string> {
  const res = await buildDirectoryDag([
    { path: "index.html", content: enc("<h1>home</h1>") },
    { path: "docs/a.txt", content: enc("alpha") },
    { path: "docs/img/b.bin", content: enc("BINARY") },
  ], adapter())
  return res.root.cid
}

describe("resolveUnixfsPath", () => {
  it("navigates a nested file by name", async () => {
    const root = await sampleTree()
    const entry = await resolveUnixfsPath(root, ["docs", "a.txt"], adapter())
    assert.equal(entry.type, "file")
    assert.equal(dec(await readEntryBytes(entry)), "alpha")
  })

  it("navigates two levels deep", async () => {
    const root = await sampleTree()
    const entry = await resolveUnixfsPath(root, ["docs", "img", "b.bin"], adapter())
    assert.equal(dec(await readEntryBytes(entry)), "BINARY")
  })

  it("resolves the root itself with an empty path", async () => {
    const root = await sampleTree()
    const entry = await resolveUnixfsPath(root, [], adapter())
    assert.equal(entry.type, "directory")
    assert.equal(entry.cid, root)
  })

  it("lists directory children", async () => {
    const root = await sampleTree()
    const dir = await resolveUnixfsPath(root, ["docs"], adapter())
    const links = await listDirectory(dir)
    const names = links.map((l) => l.name).sort()
    assert.deepEqual(names, ["a.txt", "img"])
    assert.equal(links.find((l) => l.name === "img")?.type, "directory")
    assert.equal(links.find((l) => l.name === "a.txt")?.type, "file")
  })

  it("throws not_found for a missing path component", async () => {
    const root = await sampleTree()
    await assert.rejects(
      () => resolveUnixfsPath(root, ["nope.txt"], adapter()),
      (err: unknown) => err instanceof PathResolveError && err.kind === "not_found",
    )
  })

  it("throws not_a_directory when descending into a file", async () => {
    const root = await sampleTree()
    await assert.rejects(
      () => resolveUnixfsPath(root, ["index.html", "x"], adapter()),
      (err: unknown) => err instanceof PathResolveError && err.kind === "not_a_directory" && err.depth === 1,
    )
  })

  it("rejects a path deeper than MAX_PATH_DEPTH", async () => {
    const root = await sampleTree()
    const deep = Array.from({ length: MAX_PATH_DEPTH + 1 }, (_, i) => `s${i}`)
    await assert.rejects(
      () => resolveUnixfsPath(root, deep, adapter()),
      (err: unknown) => err instanceof PathResolveError && /too deep/.test(err.message),
    )
  })

  it("navigates a HAMT-sharded directory by name", async () => {
    const entries = Array.from({ length: 4000 }, (_, i) => ({
      path: `entry-with-a-long-name-${i}.dat`,
      content: enc(`v${i}`),
    }))
    const res = await buildDirectoryDag(entries, adapter())
    assert.equal(res.root.type, "hamt-sharded-directory")
    const target = await resolveUnixfsPath(res.root.cid, ["entry-with-a-long-name-2718.dat"], adapter())
    assert.equal(dec(await readEntryBytes(target)), "v2718")
  })
})

describe("readEntryBytes", () => {
  it("rejects reading a directory as a file", async () => {
    const root = await sampleTree()
    const dir = await resolveUnixfsPath(root, [], adapter())
    await assert.rejects(() => readEntryBytes(dir), /is a directory/)
  })
})

describe("isParsableCid", () => {
  it("accepts a valid CID and rejects garbage", async () => {
    const root = await sampleTree()
    assert.equal(isParsableCid(root), true)
    assert.equal(isParsableCid("not-a-cid"), false)
  })
})
