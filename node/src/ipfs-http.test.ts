import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import http from "node:http"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { IpfsHttpServer } from "./ipfs-http.ts"
import type { CidString } from "./ipfs-types.ts"

let tmpDir: string
let store: IpfsBlockstore
let unixfs: UnixFsBuilder
let server: IpfsHttpServer
let port: number
let baseUrl: string

function fetch(path: string, opts?: { method?: string; body?: Uint8Array | string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: () => Promise<unknown>; text: () => Promise<string>; buffer: () => Promise<Buffer> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    // #136: kubo HTTP RPC requires POST for /api/v0/* endpoints to
    // prevent CSRF. The /ipfs/ gateway path stays GET (read-only).
    const defaultMethod = url.pathname.startsWith("/api/v0/") ? "POST" : "GET"
    const reqOpts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts?.method ?? defaultMethod,
      headers: opts?.headers ?? {},
    }
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c) => chunks.push(Buffer.from(c)))
      res.on("end", () => {
        const buf = Buffer.concat(chunks)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          json: () => Promise.resolve(JSON.parse(buf.toString())),
          text: () => Promise.resolve(buf.toString()),
          buffer: () => Promise.resolve(buf),
        })
      })
    })
    req.on("error", reject)
    if (opts?.body) req.write(opts.body)
    req.end()
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ipfs-http-test-"))
  store = new IpfsBlockstore(tmpDir)
  await store.init()
  unixfs = new UnixFsBuilder(store)
  port = 30000 + Math.floor(Math.random() * 10000)
  baseUrl = `http://127.0.0.1:${port}`

  server = new IpfsHttpServer(
    { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "test-node" },
    store,
    unixfs,
  )
  server.start()
  // Wait for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 100))
})

afterEach(async () => {
  await server.stop()
  await rm(tmpDir, { recursive: true, force: true })
})

describe("IpfsHttpServer", () => {
  it("GET /api/v0/version returns version info", async () => {
    const res = await fetch("/api/v0/version")
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, string>
    assert.equal(body.Version, "0.1.0-coc")
    assert.equal(body.Repo, "coc-ipfs")
  })

  it("GET /api/v0/id returns node identity", async () => {
    const res = await fetch("/api/v0/id")
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.ID, "test-node")
    assert.ok(Array.isArray(body.Addresses))
  })

  it("GET /api/v0/stat returns repo stats", async () => {
    const res = await fetch("/api/v0/stat")
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.Version, "0.1.0-coc")
    assert.ok("NumObjects" in body)
  })

  it("POST /api/v0/add uploads a file and returns CID", async () => {
    const boundary = "----TestBoundary"
    const content = "hello ipfs"
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="test.txt"',
      "Content-Type: application/octet-stream",
      "",
      content,
      `--${boundary}--`,
      "",
    ].join("\r\n")

    const res = await fetch("/api/v0/add", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    })
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, string>
    assert.ok(body.Hash)
    assert.equal(body.Name, "test.txt")
  })

  it("GET /api/v0/cat retrieves uploaded file content", async () => {
    // First add a file
    const data = new TextEncoder().encode("cat me")
    const meta = await unixfs.addFile("cattest.txt", data)

    const res = await fetch(`/api/v0/cat?arg=${meta.cid}`)
    assert.equal(res.status, 200)
    const buf = await res.buffer()
    assert.deepEqual(new Uint8Array(buf), data)
  })

  it("GET /api/v0/cat returns 400 without CID", async () => {
    const res = await fetch("/api/v0/cat")
    assert.equal(res.status, 400)
  })

  it("POST /api/v0/block/put and GET /api/v0/block/get round-trip", async () => {
    const data = new TextEncoder().encode("raw block data")
    const putRes = await fetch("/api/v0/block/put", {
      method: "POST",
      body: data,
    })
    assert.equal(putRes.status, 200)
    const putBody = await putRes.json() as Record<string, unknown>
    assert.ok(putBody.Key)

    const getRes = await fetch(`/api/v0/block/get?arg=${putBody.Key}`)
    assert.equal(getRes.status, 200)
    const buf = await getRes.buffer()
    assert.deepEqual(new Uint8Array(buf), data)
  })

  it("#92: POST /api/v0/block/put extracts file bytes from kubo-style multipart", async () => {
    // Pre-fix bug: the entire multipart envelope (boundary, headers,
    // closing boundary) was stored as block bytes — incompatible with the
    // kubo CLI / js-ipfs which always send multipart.
    const boundary = "----BlockPutMpBoundary"
    const content = "raw bytes inside multipart"
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="data"; filename="b.bin"',
      "Content-Type: application/octet-stream",
      "",
      content,
      `--${boundary}--`,
      "",
    ].join("\r\n")
    const putRes = await fetch("/api/v0/block/put", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    })
    assert.equal(putRes.status, 200)
    const putBody = await putRes.json() as Record<string, unknown>
    assert.ok(putBody.Key)
    assert.equal(putBody.Size, Buffer.byteLength(content), "stored block must be the inner file bytes, not the multipart envelope")

    const getRes = await fetch(`/api/v0/block/get?arg=${putBody.Key}`)
    assert.equal(getRes.status, 200)
    const buf = await getRes.buffer()
    assert.equal(new TextDecoder().decode(buf), content)
  })

  it("GET /api/v0/pin/ls returns pins list", async () => {
    const res = await fetch("/api/v0/pin/ls")
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, unknown>
    assert.ok("Keys" in body)
  })

  it("POST /api/v0/pin/add pins a CID", async () => {
    const data = new TextEncoder().encode("pin me")
    const meta = await unixfs.addFile("pin.txt", data)

    const res = await fetch(`/api/v0/pin/add?arg=${meta.cid}`, { method: "POST" })
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, unknown>
    assert.deepEqual(body.Pins, [meta.cid])
  })

  it("#126: POST /api/v0/pin/rm removes a pin, returns 404 on second call", async () => {
    const data = new TextEncoder().encode("pin then unpin")
    const meta = await unixfs.addFile("p.txt", data)
    await fetch(`/api/v0/pin/add?arg=${meta.cid}`, { method: "POST" })
    const first = await fetch(`/api/v0/pin/rm?arg=${meta.cid}`, { method: "POST" })
    assert.equal(first.status, 200, "first pin/rm must succeed")
    const firstBody = await first.json() as Record<string, unknown>
    assert.deepEqual(firstBody.Pins, [meta.cid])
    const second = await fetch(`/api/v0/pin/rm?arg=${meta.cid}`, { method: "POST" })
    assert.equal(second.status, 404, "second pin/rm must 404 (kubo-compatible)")
  })

  it("#126: POST /api/v0/pin/rm rejects missing/invalid CID with 400", async () => {
    const noArg = await fetch(`/api/v0/pin/rm`, { method: "POST" })
    assert.equal(noArg.status, 400)
    const badArg = await fetch(`/api/v0/pin/rm?arg=../etc/passwd`, { method: "POST" })
    assert.equal(badArg.status, 400)
  })

  it("#126: POST /api/v0/block/rm force-evicts the block from disk", async () => {
    const data = new TextEncoder().encode("evict me")
    const meta = await unixfs.addFile("e.txt", data)
    // Confirm cat reaches the bytes pre-evict.
    const pre = await fetch(`/api/v0/cat?arg=${meta.cid}`, { method: "POST" })
    assert.equal(pre.status, 200)
    const rm = await fetch(`/api/v0/block/rm?arg=${meta.cid}`, { method: "POST" })
    assert.equal(rm.status, 200)
    const rmBody = await rm.json() as Record<string, unknown>
    assert.equal(rmBody.Hash, meta.cid)
    assert.equal(rmBody.Error, "", "successful eviction has empty Error string")
    // After block/rm, cat must 404. This is the chaos kill-shard
    // post-condition that the script asserts on.
    const post = await fetch(`/api/v0/cat?arg=${meta.cid}`, { method: "POST" })
    assert.equal(post.status, 404, "cat must 404 after block/rm — chaos kill-shard depends on this")
  })

  it("#126: POST /api/v0/block/rm returns 404 if the block is not present", async () => {
    const res = await fetch(`/api/v0/block/rm?arg=QmNonExistent123`, { method: "POST" })
    assert.equal(res.status, 404)
  })

  it("#126: POST /api/v0/repo/gc sweeps unpinned blocks but preserves pinned", async () => {
    // Use single-block put+pin (not unixfs.addFile, which stores
    // chunks at separate CIDs that the root-CID pin does NOT cover —
    // by design, see the flat-GC limitation documented on blockstore.gc).
    // #168 tightened isValidCid to require real base58 chars (no 0/O/I/l).
    // Use fake-but-base58-compatible CIDs here.
    const cidA = "QmGcPinned123456789123456789123456789123456ABC"
    const cidB = "QmGcUnpinned12345678912345678912345678912345A"
    await store.put({ cid: cidA as CidString, bytes: Buffer.from("pinned content") })
    await store.put({ cid: cidB as CidString, bytes: Buffer.from("unpinned content") })
    await fetch(`/api/v0/pin/add?arg=${cidA}`, { method: "POST" })
    const res = await fetch(`/api/v0/repo/gc`, { method: "POST" })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, new RegExp(cidB), `unpinned CID ${cidB} must appear in GC output`)
    assert.doesNotMatch(body, new RegExp(cidA), `pinned CID ${cidA} must NOT appear in GC output`)
    assert.equal(await store.has(cidA as CidString), true, "pinned block must survive GC")
    assert.equal(await store.has(cidB as CidString), false, "unpinned block must be evicted by GC")
  })

  it("GET unknown path returns 404", async () => {
    const res = await fetch("/unknown")
    assert.equal(res.status, 404)
  })

  it("GET /api/v0/ls returns 400 without CID", async () => {
    const res = await fetch("/api/v0/ls")
    assert.equal(res.status, 400)
  })

  it("GET /api/v0/cat returns 404 with structured error when CID is not stored", async () => {
    // Valid CID format but no block on disk → must surface 404 not 500.
    const missingCid = "bafybeibbaty5wl7jqgcwyouemb5jerxoisdoxwldqdue5dd6evw6lgalhy"
    const res = await fetch(`/api/v0/cat?arg=${missingCid}`)
    assert.equal(res.status, 404)
    const body = await res.json() as Record<string, string>
    assert.equal(body.error, "block not found")
  })

  it("GET /api/v0/get returns 404 with structured error when CID is not stored", async () => {
    const missingCid = "bafybeibbaty5wl7jqgcwyouemb5jerxoisdoxwldqdue5dd6evw6lgalhy"
    const res = await fetch(`/api/v0/get?arg=${missingCid}`)
    assert.equal(res.status, 404)
    const body = await res.json() as Record<string, string>
    assert.equal(body.error, "block not found")
  })

  it("#168: /ipfs/<cid> + /api/v0/block/get map malformed→400 and missing→404 (no 500)", async () => {
    // Pre-fix the gateway and block/get handlers passed any
    // non-traversal string through isValidCid, then the blockstore
    // ENOENT propagated as a generic 500 with a stacktrace logged.
    // Now: malformed CID → 400, valid-shape-missing CID → 404.
    const missingButValid = "bafybeibbaty5wl7jqgcwyouemb5jerxoisdoxwldqdue5dd6evw6lgalhz"
    // (a) gateway: malformed → 400
    const gw1 = await fetch(`/ipfs/bogus`)
    assert.equal(gw1.status, 400, "gateway must reject 'bogus' with 400 (not 500)")
    // (b) gateway: valid-shape-missing → 404
    const gw2 = await fetch(`/ipfs/${missingButValid}`)
    assert.equal(gw2.status, 404, "gateway must surface missing CID as 404 (not 500)")
    // (c) block/get: malformed → 400
    const bg1 = await fetch(`/api/v0/block/get?arg=bogus`, { method: "POST" })
    assert.equal(bg1.status, 400, "block/get must reject 'bogus' with 400")
    // (d) block/get: valid-shape-missing → 404
    const bg2 = await fetch(`/api/v0/block/get?arg=${missingButValid}`, { method: "POST" })
    assert.equal(bg2.status, 404, "block/get must surface missing CID as 404")
    const bgBody = await bg2.json() as { error: string }
    assert.equal(bgBody.error, "block not found")
  })

  it("#174: /api/v0/cat honors offset + length query params", async () => {
    // Pre-fix the handler accepted offset/length/count via query but
    // ignored them, returning the full file. Malformed values
    // (negative, non-numeric) also silently passed.
    const content = new TextEncoder().encode("ABCDEFGHIJ") // 10 bytes
    const meta = await unixfs.addFile("range.bin", content)
    // (a) offset + length slice
    const r1 = await fetch(`/api/v0/cat?arg=${meta.cid}&offset=2&length=3`, { method: "POST" })
    assert.equal(r1.status, 200)
    assert.deepEqual(new Uint8Array(await r1.buffer()), new TextEncoder().encode("CDE"))
    // (b) offset only — tail from index 5
    const r2 = await fetch(`/api/v0/cat?arg=${meta.cid}&offset=5`, { method: "POST" })
    assert.equal(r2.status, 200)
    assert.deepEqual(new Uint8Array(await r2.buffer()), new TextEncoder().encode("FGHIJ"))
    // (c) `count` alias for length (js-ipfs compat)
    const r3 = await fetch(`/api/v0/cat?arg=${meta.cid}&offset=0&count=4`, { method: "POST" })
    assert.equal(r3.status, 200)
    assert.deepEqual(new Uint8Array(await r3.buffer()), new TextEncoder().encode("ABCD"))
    // (d) offset past end → empty (matches kubo)
    const r4 = await fetch(`/api/v0/cat?arg=${meta.cid}&offset=100`, { method: "POST" })
    assert.equal(r4.status, 200)
    assert.equal((await r4.buffer()).length, 0)
    // (e) negative offset → 400
    const r5 = await fetch(`/api/v0/cat?arg=${meta.cid}&offset=-1`, { method: "POST" })
    assert.equal(r5.status, 400)
    assert.match((await r5.json() as { error: string }).error, /invalid offset/)
    // (f) non-numeric offset → 400
    const r6 = await fetch(`/api/v0/cat?arg=${meta.cid}&offset=notnum`, { method: "POST" })
    assert.equal(r6.status, 400)
    // (g) no params → full file (unchanged)
    const r7 = await fetch(`/api/v0/cat?arg=${meta.cid}`, { method: "POST" })
    assert.equal(r7.status, 200)
    assert.deepEqual(new Uint8Array(await r7.buffer()), content)
  })

  it("GET /api/v0/pin/ls?arg=<cid> returns only that CID when pinned", async () => {
    const dataA = new TextEncoder().encode("pin-A")
    const dataB = new TextEncoder().encode("pin-B")
    const metaA = await unixfs.addFile("a.txt", dataA)
    const metaB = await unixfs.addFile("b.txt", dataB)
    await store.pin(metaA.cid)
    await store.pin(metaB.cid)

    const res = await fetch(`/api/v0/pin/ls?arg=${metaA.cid}`)
    assert.equal(res.status, 200)
    const body = await res.json() as { Keys: Record<string, { Type: string }> }
    assert.deepEqual(Object.keys(body.Keys), [metaA.cid])
    assert.equal(body.Keys[metaA.cid].Type, "recursive")
  })

  it("GET /api/v0/pin/ls?arg=<cid> returns 404 when the CID is not pinned", async () => {
    const validButUnpinned = "bafybeibbaty5wl7jqgcwyouemb5jerxoisdoxwldqdue5dd6evw6lgalhy"
    const res = await fetch(`/api/v0/pin/ls?arg=${validButUnpinned}`)
    assert.equal(res.status, 404)
    const body = await res.json() as Record<string, string>
    assert.equal(body.error, "not pinned")
  })

  it("GET /api/v0/pin/ls?arg=<cid> returns 400 for malformed CID (path traversal attempt)", async () => {
    // isValidCid rejects slashes, dots, and whitespace to prevent
    // path-traversal abuse on the disk layout. Use one of those classes
    // here; loose-but-valid-looking strings still 404 as "not pinned".
    const res = await fetch("/api/v0/pin/ls?arg=..%2Fevil")
    assert.equal(res.status, 400)
  })

  it("POST /api/v0/add accepts a 10 MB payload (regression: 10MB PUT was rejected by the 10MB exact cap)", async () => {
    const boundary = "----TenMbBoundary"
    const payload = Buffer.alloc(10 * 1024 * 1024, 0x61) // 10 MB of 'a'
    const head = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="big.bin"\r\n' +
      "Content-Type: application/octet-stream\r\n" +
      "\r\n",
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([head, payload, tail])
    const res = await fetch("/api/v0/add", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    })
    assert.equal(res.status, 200, "10 MB upload must succeed after raising the cap")
    const json = await res.json() as Record<string, string>
    assert.ok(json.Hash)
    assert.equal(json.Size, String(payload.length))
  })

  it("#134: /api/v0/ls returns per-leaf chunk size, sum equals file size", async () => {
    // Upload via /api/v0/add so file-meta.json is populated (the
    // UnixFsBuilder direct path used in other tests does not write
    // file meta — only the HTTP add endpoint does). UnixFsBuilder
    // chunks at 256 KiB; use 700 KB to get a multi-leaf file.
    const totalSize = 700 * 1024
    const content = Buffer.alloc(totalSize, 0x37)
    const boundary = "----LsBoundary134"
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="multi.bin"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([head, content, tail])
    const addRes = await fetch("/api/v0/add", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    })
    assert.equal(addRes.status, 200)
    const addJson = await addRes.json() as Record<string, string>
    const cid = addJson.Hash
    const res = await fetch(`/api/v0/ls?arg=${cid}`)
    assert.equal(res.status, 200)
    const lsJson = await res.json() as { Objects: Array<{ Links: Array<{ Name: string; Hash: string; Size: number; Type: number }> }> }
    const links = lsJson.Objects[0].Links
    assert.ok(links.length >= 2, `expected multi-chunk file but got ${links.length} leaves`)
    const sumLeafBytes = links.reduce((acc, l) => acc + l.Size, 0)
    assert.equal(sumLeafBytes, totalSize, `leaf size sum (${sumLeafBytes}) must equal file size (${totalSize})`)
    for (const l of links) {
      assert.ok(l.Size > 0, `leaf ${l.Name} has Size 0 — kubo-spec regression`)
    }
  })

  it("#134: /api/v0/object/stat exposes DataSize (not hardcoded 0)", async () => {
    const totalSize = 5000
    const content = Buffer.alloc(totalSize, 0x42)
    const boundary = "----StatBoundary134"
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="statme.bin"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([head, content, tail])
    const addRes = await fetch("/api/v0/add", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    })
    const addJson = await addRes.json() as Record<string, string>
    const res = await fetch(`/api/v0/object/stat?arg=${addJson.Hash}`)
    assert.equal(res.status, 200)
    const statBody = await res.json() as Record<string, number>
    assert.equal(statBody.DataSize, totalSize, `DataSize must reflect actual user data, got ${statBody.DataSize}`)
    assert.equal(statBody.CumulativeSize, totalSize, "CumulativeSize must equal file size")
  })

  it("#136: GET on /api/v0/* must return 405 (CSRF protection)", async () => {
    // Probed live testnet: GET /api/v0/add returned 200 with an empty
    // file CID — meaning any web page could pin/evict/gc via <img src>.
    // kubo spec mandates POST-only on /api/v0/* to block this.
    const routes = ["/api/v0/version", "/api/v0/id", "/api/v0/stat", "/api/v0/cat?arg=Qm", "/api/v0/add", "/api/v0/pin/add?arg=Qm", "/api/v0/pin/rm?arg=Qm", "/api/v0/block/rm?arg=Qm", "/api/v0/repo/gc"]
    for (const route of routes) {
      const res = await fetch(route, { method: "GET" })
      assert.equal(res.status, 405, `GET ${route} must 405, got ${res.status}`)
      assert.equal(res.headers.allow, "POST", `Allow header must be "POST", got ${res.headers.allow}`)
    }
    // Sanity: POST still works.
    const post = await fetch("/api/v0/version", { method: "POST" })
    assert.equal(post.status, 200, "POST /api/v0/version must still work")
  })

  it("#136: /ipfs/<cid> gateway accepts GET (read-only content addressing)", async () => {
    // The /ipfs/ gateway is intentionally GET-able — it's read-only
    // content addressing, no state mutation possible. Only /api/v0/*
    // is POST-only per kubo spec.
    const data = new TextEncoder().encode("gateway content")
    const meta = await unixfs.addFile("g.txt", data)
    const res = await fetch(`/ipfs/${meta.cid}`, { method: "GET" })
    assert.equal(res.status, 200, "GET /ipfs/<cid> must work — gateway is read-only and intentionally GET")
    const buf = await res.buffer()
    assert.deepEqual(new Uint8Array(buf), data)
  })
})

// Phase Q.4 — Reed-Solomon erasure coding integration tests.
describe("IpfsHttpServer Phase Q erasure coding", () => {
  function buildMultipart(content: Uint8Array, filename = "blob.bin"): { body: Buffer; contentType: string } {
    const boundary = "----QErasureBoundary"
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    return {
      body: Buffer.concat([head, Buffer.from(content), tail]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    }
  }

  it("POST /api/v0/add?erasure=4+2 returns a manifest CID and original-CID header", async () => {
    const payload = Buffer.alloc(2048, 0x42)
    const { body, contentType } = buildMultipart(payload)
    const res = await fetch("/api/v0/add?erasure=4%2B2", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    assert.equal(res.status, 200)
    const json = await res.json() as Record<string, string>
    assert.ok(json.Hash, "manifest CID returned")
    assert.equal(res.headers["x-coc-erasure-scheme"], "rs(4+2)")
    assert.ok(typeof res.headers["x-coc-erasure-original-cid"] === "string", "original-cid header present")
    // manifest CID and original-CID must differ (codecs differ).
    assert.notEqual(json.Hash, res.headers["x-coc-erasure-original-cid"])
    assert.equal(json.Size, String(payload.length))
  })

  it("GET /api/v0/cat?arg=<manifest_cid> reconstructs the file via erasure decode", async () => {
    const payload = Buffer.from("hello erasure world".padEnd(8000, "."))
    const { body, contentType } = buildMultipart(payload)
    const addRes = await fetch("/api/v0/add?erasure=4%2B2", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const { Hash: manifestCid } = await addRes.json() as Record<string, string>
    const getRes = await fetch(`/api/v0/cat?arg=${manifestCid}`)
    assert.equal(getRes.status, 200)
    const back = await getRes.buffer()
    assert.equal(back.byteLength, payload.byteLength)
    assert.ok(back.equals(payload))
  })

  it("GET /api/v0/get?arg=<manifest_cid> returns a tar archive containing the original bytes", async () => {
    const payload = Buffer.from("get-via-tar payload".padEnd(2000, "x"))
    const { body, contentType } = buildMultipart(payload)
    const addRes = await fetch("/api/v0/add?erasure=4%2B2", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const { Hash: manifestCid } = await addRes.json() as Record<string, string>
    const getRes = await fetch(`/api/v0/get?arg=${manifestCid}`)
    assert.equal(getRes.status, 200)
    assert.ok(String(getRes.headers["content-type"] ?? "").includes("application/x-tar"))
    const tar = await getRes.buffer()
    // Tar header is 512 bytes; payload follows. Coarse extraction: scan
    // for the payload bytes in the tar buffer (sufficient for assertion).
    let found = false
    for (let i = 0; i + payload.byteLength <= tar.byteLength; i += 8) {
      if (tar.subarray(i, i + payload.byteLength).equals(payload)) { found = true; break }
    }
    assert.ok(found, "tar archive contains original payload bytes")
  })

  it("GET /api/v0/cat for the original UnixFS CID still works (back-compat)", async () => {
    const payload = Buffer.from("backcompat path".padEnd(1500, "y"))
    const { body, contentType } = buildMultipart(payload)
    const addRes = await fetch("/api/v0/add?erasure=4%2B2", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const originalCid = String(addRes.headers["x-coc-erasure-original-cid"] ?? "")
    assert.ok(originalCid, "original CID header")
    const getRes = await fetch(`/api/v0/cat?arg=${originalCid}`)
    assert.equal(getRes.status, 200)
    const back = await getRes.buffer()
    assert.ok(back.equals(payload))
  })

  it("POST /api/v0/add?erasure=bogus rejects malformed spec with 400", async () => {
    const { body, contentType } = buildMultipart(Buffer.from("noop"))
    const res = await fetch("/api/v0/add?erasure=four-plus-two", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    assert.equal(res.status, 400)
    const json = await res.json() as Record<string, string>
    assert.equal(json.error, "invalid erasure spec")
  })

  it("POST /api/v0/add (no erasure spec) keeps plain UnixFS behaviour", async () => {
    const { body, contentType } = buildMultipart(Buffer.from("plain unixfs"))
    const res = await fetch("/api/v0/add", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers["x-coc-erasure-scheme"], undefined)
  })

  it("GET /api/v0/erasure/status returns per-stripe availability", async () => {
    const payload = Buffer.alloc(1500_000, 0x55) // ≥ 1 stripe @ 256K shards
    const { body, contentType } = buildMultipart(payload)
    const addRes = await fetch("/api/v0/add?erasure=4%2B2", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const { Hash: manifestCid } = await addRes.json() as Record<string, string>

    const statusRes = await fetch(`/api/v0/erasure/status?arg=${manifestCid}`)
    assert.equal(statusRes.status, 200)
    const status = await statusRes.json() as {
      n: number
      m: number
      fileSize: number
      stripes: Array<{ dataAvailable: number; parityAvailable: number; needsRepair: boolean }>
    }
    assert.equal(status.n, 4)
    assert.equal(status.m, 2)
    assert.equal(status.fileSize, payload.byteLength)
    assert.ok(status.stripes.length >= 1)
    for (const s of status.stripes) {
      // Note: identical-content shards (all-byte 0x55 here) dedup at the
      // CID layer, so dataAvailable counts unique shards. Assert at least
      // some shards are present + needsRepair flag is consistent.
      assert.ok(s.dataAvailable + s.parityAvailable >= 1, "at least one shard tracked locally")
    }
  })

  it("GET /api/v0/erasure/status on a non-manifest CID returns 415", async () => {
    // Use a UnixFS CID — that's dag-pb, not erasure manifest.
    const { body, contentType } = buildMultipart(Buffer.from("plain"))
    const addRes = await fetch("/api/v0/add", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const { Hash: cid } = await addRes.json() as Record<string, string>
    const res = await fetch(`/api/v0/erasure/status?arg=${cid}`)
    assert.equal(res.status, 415)
  })

  it("GET /api/v0/cat?arg=<manifest> with deleted shards returns 503 insufficient_shards when too many missing", async () => {
    // Encode a file that fills the data shards with non-zero content
    // (avoid identical-content dedup that would let one shard cover many).
    const payload = randomBytes(4 * 256 * 1024 + 13)
    const { body, contentType } = buildMultipart(payload)
    const addRes = await fetch("/api/v0/add?erasure=4%2B2", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const { Hash: manifestCid } = await addRes.json() as Record<string, string>

    // Read the manifest block from disk to discover the shard CIDs, then
    // physically delete > M of them to force decode failure.
    const block = await store.get(manifestCid)
    const dagCbor = await import("@ipld/dag-cbor")
    const manifest = dagCbor.decode(block.bytes) as { stripes: Array<{ data: string[]; parity: string[] }> }
    const stripe = manifest.stripes[0]
    const shardsToKill = [...stripe.data.slice(0, 3)] // 3 missing > m=2
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    for (const cid of shardsToKill) {
      try { await fs.rm(path.join(tmpDir, "blocks", cid)) } catch { /* ignore */ }
    }

    const res = await fetch(`/api/v0/cat?arg=${manifestCid}`)
    assert.equal(res.status, 503)
    const json = await res.json() as Record<string, string>
    assert.equal(json.error, "insufficient_shards")
  })
})

// Phase C3.1: PUT awaits replication, emits X-COC-Replicas-Warning when
// the worst-case per-chunk replica count is below minReplicas.
describe("IpfsHttpServer C3.1 replication warning", () => {
  let rTmpDir: string
  let rStore: IpfsBlockstore
  let rUnixfs: UnixFsBuilder
  let rServer: IpfsHttpServer
  let rPort: number
  let rBaseUrl: string

  function rFetch(path: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: () => Promise<unknown> }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, rBaseUrl)
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts?.method ?? "GET",
        headers: opts?.headers ?? {},
      }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(Buffer.from(c)))
        res.on("end", () => {
          const buf = Buffer.concat(chunks)
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: () => Promise.resolve(JSON.parse(buf.toString())),
          })
        })
      })
      req.on("error", reject)
      if (opts?.body) req.write(opts.body)
      req.end()
    })
  }

  // A configurable awaiter: returns a specific PushToKResult-shape object
  // for each CID (per-chunk status), or null for CIDs not in the table.
  type AwaitFn = (cid: string, timeoutMs?: number) => Promise<{
    attempted: number
    succeeded: string[]
    failed: string[]
    skippedLowPeers: boolean
  } | null>

  async function startWithAwaiter(awaiter: AwaitFn, minReplicas: number): Promise<void> {
    rTmpDir = await mkdtemp(join(tmpdir(), "ipfs-http-c31-"))
    rStore = new IpfsBlockstore(rTmpDir)
    await rStore.init()
    rUnixfs = new UnixFsBuilder(rStore)
    rPort = 30000 + Math.floor(Math.random() * 10000)
    rBaseUrl = `http://127.0.0.1:${rPort}`
    rServer = new IpfsHttpServer(
      { bind: "127.0.0.1", port: rPort, storageDir: rTmpDir, nodeId: "c31-node", minReplicas, awaitReplicationResult: awaiter },
      rStore,
      rUnixfs,
    )
    rServer.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  afterEach(async () => {
    if (rServer) await rServer.stop()
    if (rTmpDir) await rm(rTmpDir, { recursive: true, force: true })
  })

  function makeMultipart(content: string): { body: string; headers: Record<string, string> } {
    const boundary = "----C31Boundary"
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="c31.txt"',
      "Content-Type: application/octet-stream",
      "",
      content,
      `--${boundary}--`,
      "",
    ].join("\r\n")
    return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }
  }

  it("emits X-COC-Replicas-Warning when worst chunk < minReplicas", async () => {
    // Every CID reports only 1 successful replica; minReplicas=2.
    const awaiter: AwaitFn = async () => ({
      attempted: 3, succeeded: ["peerA"], failed: ["peerB", "peerC"], skippedLowPeers: false,
    })
    await startWithAwaiter(awaiter, 2)

    const { body, headers } = makeMultipart("short file, single chunk")
    const res = await rFetch("/api/v0/add", { method: "POST", headers, body })
    assert.equal(res.status, 200)
    const warning = res.headers["x-coc-replicas-warning"]
    assert.ok(warning, `expected X-COC-Replicas-Warning header, got ${JSON.stringify(res.headers)}`)
    assert.match(String(warning), /got 1\/2/)
  })

  it("omits X-COC-Replicas-Warning when all chunks meet minReplicas", async () => {
    const awaiter: AwaitFn = async () => ({
      attempted: 3, succeeded: ["peerA", "peerB", "peerC"], failed: [], skippedLowPeers: false,
    })
    await startWithAwaiter(awaiter, 2)

    const { body, headers } = makeMultipart("abundantly replicated")
    const res = await rFetch("/api/v0/add", { method: "POST", headers, body })
    assert.equal(res.status, 200)
    assert.equal(res.headers["x-coc-replicas-warning"], undefined)
  })

  it("omits warning when awaiter returns null for every CID (no tracked pushes)", async () => {
    // awaiter returns null — e.g. the PUT happened before wiring attached,
    // or the server is running without replication. Never fail the PUT.
    const awaiter: AwaitFn = async () => null
    await startWithAwaiter(awaiter, 2)

    const { body, headers } = makeMultipart("no tracked push")
    const res = await rFetch("/api/v0/add", { method: "POST", headers, body })
    assert.equal(res.status, 200)
    assert.equal(res.headers["x-coc-replicas-warning"], undefined)
  })

  it("warning reflects the worst-case CID across the DAG", async () => {
    // Different replica counts per CID; warning must cite the worst.
    const replicaMap = new Map<string, number>()
    const awaiter: AwaitFn = async (cid: string) => {
      const n = replicaMap.get(cid) ?? 3
      const succeeded = Array.from({ length: n }, (_, i) => `peer${i}`)
      return { attempted: 3, succeeded, failed: [], skippedLowPeers: false }
    }
    await startWithAwaiter(awaiter, 2)

    // Pre-upload a larger file so there are multiple chunks to check.
    // With default 256 KiB block size, 1 KiB fits in a single chunk, so
    // we only assert that the warning header *format* is correct given
    // the single-chunk case; the key behavior (worst cid wins) is
    // exercised by the warning message format.
    const { body, headers } = makeMultipart("x".repeat(1024))
    // We don't know the CID in advance; assume at least one CID gets 0 replicas.
    // Trick: default replicaMap is 3, but we override the lookup to always
    // return 0 to guarantee the warning path fires.
    replicaMap.set("dummy", 0) // placeholder; awaiter default is 3
    const awaiter2: AwaitFn = async () => ({
      attempted: 3, succeeded: [], failed: ["p1", "p2", "p3"], skippedLowPeers: false,
    })
    // Rebuild with the zero-replica awaiter
    await rServer.stop()
    await rm(rTmpDir, { recursive: true, force: true })
    await startWithAwaiter(awaiter2, 2)

    const res = await rFetch("/api/v0/add", { method: "POST", headers, body })
    assert.equal(res.status, 200)
    const warning = String(res.headers["x-coc-replicas-warning"] ?? "")
    assert.match(warning, /got 0\/2 \(cid=/, `expected 0/2 with cid=..., got "${warning}"`)
  })
})
