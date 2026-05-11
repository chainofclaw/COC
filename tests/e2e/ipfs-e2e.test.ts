/**
 * IPFS End-to-End Tests
 *
 * Starts a real IpfsHttpServer with MFS + Pubsub and validates all IPFS
 * functionality through HTTP requests against the running server.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "../../node/src/ipfs-blockstore.ts"
import { UnixFsBuilder } from "../../node/src/ipfs-unixfs.ts"
import { IpfsHttpServer } from "../../node/src/ipfs-http.ts"
import { IpfsMfs } from "../../node/src/ipfs-mfs.ts"
import { IpfsPubsub } from "../../node/src/ipfs-pubsub.ts"

let tmpDir: string
let port: number
let base: string
let pubsub: IpfsPubsub
let server: IpfsHttpServer

function multipart(
  filename: string,
  content: string,
): { body: string; contentType: string } {
  const boundary =
    "----E2EBound" + Date.now() + Math.random().toString(36).slice(2, 8)
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: application/octet-stream",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n")
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

describe("IPFS E2E", () => {
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)
    const mfs = new IpfsMfs(store, unixfs)
    pubsub = new IpfsPubsub({ nodeId: "e2e-node" })
    pubsub.start()

    port = 30000 + Math.floor(Math.random() * 10000)
    base = `http://127.0.0.1:${port}`

    server = new IpfsHttpServer(
      { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "e2e-node" },
      store,
      unixfs,
    )
    server.attachSubsystems({ mfs, pubsub })
    server.start()
    await new Promise((r) => setTimeout(r, 200))
  })

  after(async () => {
    pubsub.stop()
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ── 1. Server Info ──────────────────────────────────────────────────

  describe("Server Info", () => {
    it("GET /api/v0/version returns version info", async () => {
      const res = await fetch(`${base}/api/v0/version`, { method: "POST" })
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, string>
      assert.equal(body.Version, "0.1.0-coc")
      assert.ok("Commit" in body)
      assert.equal(body.Repo, "coc-ipfs")
      assert.ok(body.System)
      assert.equal(body.Golang, "n/a")
    })

    it("GET /api/v0/id returns node identity", async () => {
      const res = await fetch(`${base}/api/v0/id`, { method: "POST" })
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, unknown>
      assert.equal(body.ID, "e2e-node")
      assert.ok(Array.isArray(body.Addresses))
      assert.ok(body.AgentVersion)
      assert.ok(body.ProtocolVersion)
    })
  })

  // ── 2. File Upload & Retrieve ───────────────────────────────────────

  describe("File Upload & Retrieve", () => {
    let smallCid: string
    let largeCid: string
    let emptyCid: string

    it("uploads a small file via multipart", async () => {
      const { body, contentType } = multipart("hello.txt", "hello ipfs e2e")
      const res = await fetch(`${base}/api/v0/add`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      assert.equal(res.status, 200)
      const json = (await res.json()) as Record<string, string>
      assert.ok(json.Hash)
      assert.equal(json.Name, "hello.txt")
      assert.ok(Number(json.Size) > 0)
      smallCid = json.Hash
    })

    it("reads file via /api/v0/cat", async () => {
      const res = await fetch(`${base}/api/v0/cat?arg=${smallCid}`, { method: "POST" })
      assert.equal(res.status, 200)
      const buf = new Uint8Array(await res.arrayBuffer())
      assert.deepEqual(buf, new TextEncoder().encode("hello ipfs e2e"))
    })

    it("reads file via gateway /ipfs/{CID}", async () => {
      const res = await fetch(`${base}/ipfs/${smallCid}`)
      assert.equal(res.status, 200)
      const buf = new Uint8Array(await res.arrayBuffer())
      assert.deepEqual(buf, new TextEncoder().encode("hello ipfs e2e"))
    })

    it("uploads and reads a large file (>256KB, chunked)", async () => {
      const largeContent = "X".repeat(300 * 1024)
      const { body, contentType } = multipart("large.bin", largeContent)
      const addRes = await fetch(`${base}/api/v0/add`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      assert.equal(addRes.status, 200)
      const addJson = (await addRes.json()) as Record<string, string>
      largeCid = addJson.Hash
      assert.ok(largeCid)

      const catRes = await fetch(`${base}/api/v0/cat?arg=${largeCid}`, { method: "POST" })
      assert.equal(catRes.status, 200)
      const catBuf = new Uint8Array(await catRes.arrayBuffer())
      assert.equal(catBuf.length, 300 * 1024)
      assert.deepEqual(catBuf, new TextEncoder().encode(largeContent))
    })

    it("uploads and reads an empty file", async () => {
      const { body, contentType } = multipart("empty.txt", "")
      const addRes = await fetch(`${base}/api/v0/add`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      assert.equal(addRes.status, 200)
      const addJson = (await addRes.json()) as Record<string, string>
      emptyCid = addJson.Hash
      assert.ok(emptyCid)

      const catRes = await fetch(`${base}/api/v0/cat?arg=${emptyCid}`, { method: "POST" })
      assert.equal(catRes.status, 200)
      const catBuf = new Uint8Array(await catRes.arrayBuffer())
      assert.equal(catBuf.length, 0)
    })
  })

  // ── 3. Block API ────────────────────────────────────────────────────

  describe("Block API", () => {
    let blockCid: string

    it("PUT stores raw block and GET retrieves exact bytes", async () => {
      const data = new TextEncoder().encode("raw block data for e2e")
      const putRes = await fetch(`${base}/api/v0/block/put`, {
        method: "POST",
        body: data,
      })
      assert.equal(putRes.status, 200)
      const putJson = (await putRes.json()) as Record<string, unknown>
      assert.ok(putJson.Key)
      assert.ok(typeof putJson.Size === "number" && putJson.Size > 0)
      blockCid = putJson.Key as string

      const getRes = await fetch(`${base}/api/v0/block/get?arg=${blockCid}`, { method: "POST" })
      assert.equal(getRes.status, 200)
      const getBuf = new Uint8Array(await getRes.arrayBuffer())
      assert.deepEqual(getBuf, data)
    })

    it("block/stat returns key and size", async () => {
      const res = await fetch(`${base}/api/v0/block/stat?arg=${blockCid}`, { method: "POST" })
      assert.equal(res.status, 200)
      const json = (await res.json()) as Record<string, unknown>
      assert.equal(json.Key, blockCid)
      assert.ok(typeof json.Size === "number" && json.Size > 0)
    })
  })

  // ── 4. Object & List ───────────────────────────────────────────────

  describe("Object & List", () => {
    let fileCid: string

    before(async () => {
      const { body, contentType } = multipart("obj.txt", "object stat test")
      const res = await fetch(`${base}/api/v0/add`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      const json = (await res.json()) as Record<string, string>
      fileCid = json.Hash
    })

    it("ls lists file links for a CID", async () => {
      const res = await fetch(`${base}/api/v0/ls?arg=${fileCid}`, { method: "POST" })
      assert.equal(res.status, 200)
      const json = (await res.json()) as {
        Objects: Array<{ Hash: string; Links: unknown[] }>
      }
      assert.ok(Array.isArray(json.Objects))
      assert.equal(json.Objects[0].Hash, fileCid)
      assert.ok(Array.isArray(json.Objects[0].Links))
    })

    it("object/stat returns block metadata", async () => {
      const res = await fetch(`${base}/api/v0/object/stat?arg=${fileCid}`, { method: "POST" })
      assert.equal(res.status, 200)
      const json = (await res.json()) as Record<string, unknown>
      assert.equal(json.Hash, fileCid)
      assert.ok("NumLinks" in json)
      assert.ok("BlockSize" in json)
      assert.ok(typeof json.BlockSize === "number" && json.BlockSize > 0)
      assert.ok("CumulativeSize" in json)
    })
  })

  // ── 5. Pin API ──────────────────────────────────────────────────────

  describe("Pin API", () => {
    let pinCid: string

    before(async () => {
      const { body, contentType } = multipart("pin.txt", "pin me please")
      const res = await fetch(`${base}/api/v0/add`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      const json = (await res.json()) as Record<string, string>
      pinCid = json.Hash
    })

    it("pin/add pins a CID", async () => {
      const res = await fetch(`${base}/api/v0/pin/add?arg=${pinCid}`, {
        method: "POST",
      })
      assert.equal(res.status, 200)
      const json = (await res.json()) as { Pins: string[] }
      assert.deepEqual(json.Pins, [pinCid])
    })

    it("pin/ls includes pinned CID", async () => {
      const res = await fetch(`${base}/api/v0/pin/ls`, { method: "POST" })
      assert.equal(res.status, 200)
      const json = (await res.json()) as {
        Keys: Record<string, { Type: string }>
      }
      assert.ok(pinCid in json.Keys)
      assert.equal(json.Keys[pinCid].Type, "recursive")
    })
  })

  // ── 6. TAR Download ─────────────────────────────────────────────────

  describe("TAR Download", () => {
    it("GET /api/v0/get returns tar archive", async () => {
      const { body, contentType } = multipart("tar.txt", "tar download test")
      const addRes = await fetch(`${base}/api/v0/add`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      const addJson = (await addRes.json()) as Record<string, string>
      const cid = addJson.Hash

      const getRes = await fetch(`${base}/api/v0/get?arg=${cid}`, { method: "POST" })
      assert.equal(getRes.status, 200)
      assert.equal(getRes.headers.get("content-type"), "application/x-tar")
      const tarBuf = new Uint8Array(await getRes.arrayBuffer())
      assert.ok(tarBuf.length > 0)
    })
  })

  // ── 7. MFS Operations ──────────────────────────────────────────────

  describe("MFS Operations", () => {
    it("mkdir creates a directory with parents", async () => {
      const res = await fetch(
        `${base}/api/v0/files/mkdir?arg=/test-dir&parents=true`,
        { method: "POST" },
      )
      assert.equal(res.status, 200)
    })

    it("write creates a file in the directory", async () => {
      const res = await fetch(
        `${base}/api/v0/files/write?arg=/test-dir/hello.txt&create=true`,
        { method: "POST", body: new TextEncoder().encode("hello mfs") },
      )
      assert.equal(res.status, 200)
    })

    it("read returns file content", async () => {
      const res = await fetch(
        `${base}/api/v0/files/read?arg=/test-dir/hello.txt`,
        { method: "POST" },
      )
      assert.equal(res.status, 200)
      const buf = new Uint8Array(await res.arrayBuffer())
      assert.deepEqual(buf, new TextEncoder().encode("hello mfs"))
    })

    it("#96: read respects offset query param", async () => {
      // Pre-fix bug: HTTP handler ignored offset, always returned full file.
      // "hello mfs" → offset=6 → "mfs"
      const res = await fetch(
        `${base}/api/v0/files/read?arg=/test-dir/hello.txt&offset=6`,
        { method: "POST" },
      )
      assert.equal(res.status, 200)
      assert.equal(await res.text(), "mfs")
    })

    it("#96: read respects offset+count query params", async () => {
      // "hello mfs" → offset=0 count=5 → "hello"
      const res = await fetch(
        `${base}/api/v0/files/read?arg=/test-dir/hello.txt&offset=0&count=5`,
        { method: "POST" },
      )
      assert.equal(res.status, 200)
      assert.equal(await res.text(), "hello")
    })

    it("#96: read of nonexistent path returns 404 (not 500)", async () => {
      // Pre-fix bug: MFS "not found" errors leaked through the generic
      // catch-all as opaque 500 internal-error responses.
      const res = await fetch(
        `${base}/api/v0/files/read?arg=/no-such-file.txt`,
        { method: "POST" },
      )
      assert.equal(res.status, 404)
      const json = (await res.json()) as { error: string }
      assert.equal(json.error, "not found")
    })

    it("#98: stat/cp/mv/rm/ls of missing paths return 404 uniformly", async () => {
      // All MFS routes previously collapsed user-error throws to opaque 500.
      // Verify each route now emits a structured 404.
      for (const path of [
        "/api/v0/files/stat?arg=/no-such-stat.txt",
        "/api/v0/files/cp?arg=/no-such-cp.txt&dest=/x.txt",
        "/api/v0/files/mv?arg=/no-such-mv.txt&dest=/y.txt",
        "/api/v0/files/rm?arg=/no-such-rm.txt",
        "/api/v0/files/ls?arg=/no-such-dir",
      ]) {
        const res = await fetch(`${base}${path}`, { method: "POST" })
        assert.equal(res.status, 404, `expected 404 for ${path}, got ${res.status}`)
        const json = (await res.json()) as { error: string }
        assert.equal(json.error, "not found", `error code mismatch for ${path}`)
      }
    })

    it("#98: cp with missing dest returns 400 (not 500)", async () => {
      // Pre-fix: cp without ?dest threw a plain Error → 500.
      const res = await fetch(
        `${base}/api/v0/files/cp?arg=/test-dir/hello.txt`,
        { method: "POST" },
      )
      assert.equal(res.status, 400)
      const json = (await res.json()) as { error: string }
      assert.equal(json.error, "bad request")
    })

    it("#92: files/write extracts file bytes from kubo-style multipart upload", async () => {
      // Pre-fix bug: the entire multipart envelope (boundary, headers,
      // file content, closing boundary) was stored as the file content.
      // kubo CLI's `ipfs files write` always uses multipart/form-data, so
      // any standard IPFS client previously corrupted the file.
      const { body, contentType } = multipart("mp.txt", "hello multipart write")
      const writeRes = await fetch(
        `${base}/api/v0/files/write?arg=/test-dir/mp.txt&create=true&truncate=true`,
        { method: "POST", headers: { "content-type": contentType }, body },
      )
      assert.equal(writeRes.status, 200)
      try {
        const readRes = await fetch(
          `${base}/api/v0/files/read?arg=/test-dir/mp.txt`,
          { method: "POST" },
        )
        assert.equal(readRes.status, 200)
        const got = await readRes.text()
        assert.equal(got, "hello multipart write", "files/write must extract file bytes, not store envelope")
      } finally {
        // Clean up so the subsequent rm-empties-the-directory test still sees only hello.txt
        await fetch(`${base}/api/v0/files/rm?arg=/test-dir/mp.txt`, { method: "POST" })
      }
    })

    it("ls lists directory entries", async () => {
      const res = await fetch(`${base}/api/v0/files/ls?arg=/test-dir`, {
        method: "POST",
      })
      assert.equal(res.status, 200)
      const json = (await res.json()) as {
        Entries: Array<{ Name: string; Type: number; Size: number }>
      }
      const names = json.Entries.map((e) => e.Name)
      assert.ok(names.includes("hello.txt"))
    })

    it("stat returns file metadata in kubo-compat PascalCase shape (#158)", async () => {
      const res = await fetch(
        `${base}/api/v0/files/stat?arg=/test-dir/hello.txt`,
        { method: "POST" },
      )
      assert.equal(res.status, 200)
      const json = (await res.json()) as Record<string, unknown>
      // #158: kubo's /api/v0/files/stat returns PascalCase keys.
      // Pre-fix we emitted camelCase (hash/size/cumulativeSize/type/blocks)
      // which broke ipfs-http-client + every other kubo-compat client.
      assert.ok(json.Hash, "must have PascalCase Hash field")
      assert.ok(typeof json.Size === "number", "Size must be a number")
      assert.equal(json.Type, "file")
      assert.ok(typeof json.CumulativeSize === "number")
      assert.ok(typeof json.Blocks === "number")
      // Negative: legacy camelCase keys must NOT be present.
      assert.equal(json.hash, undefined, "legacy camelCase hash must be gone")
      assert.equal(json.size, undefined, "legacy camelCase size must be gone")
      assert.equal(json.type, undefined, "legacy camelCase type must be gone")
    })

    it("rm removes file and ls shows empty directory", async () => {
      const rmRes = await fetch(
        `${base}/api/v0/files/rm?arg=/test-dir/hello.txt`,
        { method: "POST" },
      )
      assert.equal(rmRes.status, 200)

      const lsRes = await fetch(`${base}/api/v0/files/ls?arg=/test-dir`, {
        method: "POST",
      })
      assert.equal(lsRes.status, 200)
      const json = (await lsRes.json()) as {
        Entries: Array<{ Name: string }>
      }
      assert.equal(json.Entries.length, 0)
    })
  })

  // ── 8. Pubsub ──────────────────────────────────────────────────────

  describe("Pubsub", () => {
    it("publish to topic returns 200", async () => {
      const res = await fetch(`${base}/api/v0/pubsub/pub?arg=e2e-topic`, {
        method: "POST",
        body: new TextEncoder().encode("hello pubsub"),
      })
      assert.equal(res.status, 200)
      const json = (await res.json()) as { ok: boolean }
      assert.equal(json.ok, true)
    })

    it("#92: pubsub/pub delivers inner bytes from kubo-style multipart message", async () => {
      // Pre-fix bug: publish() received the full multipart envelope as the
      // message body. Subscribers then got the envelope instead of the
      // intended payload.
      const received: Uint8Array[] = []
      pubsub.subscribe("mp-topic", (msg) => { received.push(msg.data) })
      try {
        const { body, contentType } = multipart("msg.bin", "hello mp message")
        const res = await fetch(`${base}/api/v0/pubsub/pub?arg=mp-topic`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        })
        assert.equal(res.status, 200)
        // Subscribers run synchronously inside publish() in this impl, so
        // we don't need to await dispatch.
        assert.equal(received.length, 1, "exactly one message delivered")
        assert.equal(new TextDecoder().decode(received[0]), "hello mp message")
      } finally {
        pubsub.unsubscribe("mp-topic")
      }
    })

    it("ls lists subscribed topics", async () => {
      // Subscribe via the pubsub instance to create an active topic
      const handler = () => {}
      pubsub.subscribe("ls-test-topic", handler)
      try {
        const res = await fetch(`${base}/api/v0/pubsub/ls`, { method: "POST" })
        assert.equal(res.status, 200)
        const json = (await res.json()) as { Strings: string[] }
        assert.ok(Array.isArray(json.Strings))
        assert.ok(json.Strings.includes("ls-test-topic"))
      } finally {
        pubsub.unsubscribe("ls-test-topic", handler)
      }
    })
  })

  // ── 9. Error Cases ─────────────────────────────────────────────────

  describe("Error Cases", () => {
    it("cat with non-existent CID returns error", async () => {
      const fakeCid = "bafkreiaaaaaaaaaaaaaaaaaaaaaa"
      const res = await fetch(`${base}/api/v0/cat?arg=${fakeCid}`, { method: "POST" })
      assert.ok(res.status >= 400)
    })

    it("cat without arg returns 400", async () => {
      const res = await fetch(`${base}/api/v0/cat`, { method: "POST" })
      assert.equal(res.status, 400)
    })
  })

  // ── 10. Repo Stats ─────────────────────────────────────────────────

  describe("Repo Stats", () => {
    it("stat shows non-zero objects after uploads", async () => {
      const res = await fetch(`${base}/api/v0/stat`, { method: "POST" })
      assert.equal(res.status, 200)
      const json = (await res.json()) as Record<string, unknown>
      assert.ok(typeof json.RepoSize === "number")
      assert.ok(typeof json.NumObjects === "number")
      assert.ok((json.NumObjects as number) > 0)
      assert.ok((json.RepoSize as number) > 0)
      assert.equal(json.Version, "0.1.0-coc")
    })
  })
})
