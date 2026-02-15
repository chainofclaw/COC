import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import http from "node:http"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { IpfsHttpServer } from "./ipfs-http.ts"

let tmpDir: string
let store: IpfsBlockstore
let unixfs: UnixFsBuilder
let port: number
let baseUrl: string

function fetch(path: string, opts?: { method?: string; body?: Uint8Array | string; headers?: Record<string, string> }): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string>; buffer: () => Promise<Buffer> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const reqOpts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts?.method ?? "GET",
      headers: opts?.headers ?? {},
    }
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c) => chunks.push(Buffer.from(c)))
      res.on("end", () => {
        const buf = Buffer.concat(chunks)
        resolve({
          status: res.statusCode ?? 0,
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

  const server = new IpfsHttpServer(
    { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "test-node" },
    store,
    unixfs,
  )
  server.start()
  // Wait for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 100))
})

afterEach(async () => {
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

  it("GET unknown path returns 404", async () => {
    const res = await fetch("/unknown")
    assert.equal(res.status, 404)
  })

  it("GET /api/v0/ls returns 400 without CID", async () => {
    const res = await fetch("/api/v0/ls")
    assert.equal(res.status, 400)
  })
})
