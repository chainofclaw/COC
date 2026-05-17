/**
 * IPFS End-to-End Tests — Extended Coverage
 *
 * Companion suite to ipfs-e2e.test.ts. Covers functionality the base suite
 * does not exercise end-to-end over HTTP:
 *   1. Admin auth gate (block/rm, repo/gc, pin/rm) — loopback vs. token vs.
 *      anonymous non-loopback caller.
 *   2. Gateway HTTP Range (206 partial content) + HEAD parity.
 *   3. Concurrent /api/v0/add uploads — unique CIDs, all independently catable.
 *   4. MFS round-trip — mkdir → write → read → ls → stat → rm.
 *   5. Pubsub round-trip — publish reaches a subscriber.
 *
 * Same conventions as the base suite: node:test, node:assert/strict, explicit
 * .ts import extensions, random ports, tmpdir cleanup.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { networkInterfaces } from "node:os"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { IpfsBlockstore } from "../../node/src/ipfs-blockstore.ts"
import { UnixFsBuilder } from "../../node/src/ipfs-unixfs.ts"
import { IpfsHttpServer } from "../../node/src/ipfs-http.ts"
import { IpfsMfs } from "../../node/src/ipfs-mfs.ts"
import { IpfsPubsub } from "../../node/src/ipfs-pubsub.ts"

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

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000)
}

/**
 * Compute a genuine raw-block CIDv1 (codec=0x55, sha-256) for the given
 * bytes — the same encoding `storeRawBlock` uses — WITHOUT putting it in
 * any blockstore. The result is a syntactically valid, fully-decodable
 * CID that is guaranteed missing from a fresh server, so a gateway probe
 * exercises the 404 (block-not-found) path rather than the 400
 * (invalid-CID) path.
 */
async function unstoredRawCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes)
  return CID.createV1(0x55, digest).toString()
}

/**
 * First non-internal IPv4 address of the host, or null when the machine
 * only has loopback. The admin auth gate (#344) treats loopback as always
 * authorized, so exercising the token branch over HTTP requires connecting
 * via a non-loopback address.
 */
function firstNonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address
    }
  }
  return null
}

// ── 1. Admin Auth Gate ────────────────────────────────────────────────
//
// #344/#460: block/rm, repo/gc and pin/rm are state-destroying. The gate
// in isIpfsAdminAuthorized() allows: (a) any loopback caller, OR (b) a
// non-loopback caller presenting a matching X-COC-IPFS-Admin-Token header
// when adminAuthToken is configured. A non-loopback caller without a valid
// token gets 403.
//
// To drive the non-loopback branch over real HTTP we bind to 0.0.0.0 and
// connect via the host's LAN IP — req.socket.remoteAddress is then the
// non-loopback address (it is NOT spoofable via headers).

describe("IPFS E2E Extended — Admin Auth Gate", () => {
  const GATED_ROUTES = [
    "/api/v0/block/rm",
    "/api/v0/repo/gc",
    "/api/v0/pin/rm",
  ]
  const lanIp = firstNonLoopbackIPv4()

  let tmpDir: string
  let server: IpfsHttpServer
  let loopbackBase: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-auth-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)

    const port = randomPort()
    loopbackBase = `http://127.0.0.1:${port}`

    // Bind to 0.0.0.0 so the server is reachable both via loopback and,
    // when available, via the host LAN IP (non-loopback).
    server = new IpfsHttpServer(
      {
        bind: "0.0.0.0",
        port,
        storageDir: tmpDir,
        nodeId: "e2e-auth-node",
        adminAuthToken: "e2e-secret-token-abc",
      },
      store,
      unixfs,
    )
    server.start()
    await new Promise((r) => setTimeout(r, 200))
  })

  after(async () => {
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  /** Upload a file via /api/v0/add and return its CID. */
  async function addFile(content: string): Promise<string> {
    const { body, contentType } = multipart("admin.txt", content)
    const res = await fetch(`${loopbackBase}/api/v0/add`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const json = (await res.json()) as Record<string, string>
    return json.Hash
  }

  it("loopback caller is allowed on all gated routes (succeeds, not 403)", async () => {
    // pin/rm requires a genuinely-pinned CID (kubo parity: 404 if not
    // pinned), so upload + pin one first. block/rm + repo/gc are
    // idempotent and 200 regardless.
    const pinCid = await addFile(`admin-pin-${Math.random()}`)
    const pinAddRes = await fetch(
      `${loopbackBase}/api/v0/pin/add?arg=${pinCid}`,
      { method: "POST" },
    )
    assert.equal(pinAddRes.status, 200, "pin/add precondition must succeed")

    const blockCid = await addFile(`admin-block-${Math.random()}`)

    const probes: Array<{ route: string; url: string }> = [
      { route: "/api/v0/pin/rm", url: `${loopbackBase}/api/v0/pin/rm?arg=${pinCid}` },
      { route: "/api/v0/block/rm", url: `${loopbackBase}/api/v0/block/rm?arg=${blockCid}` },
      { route: "/api/v0/repo/gc", url: `${loopbackBase}/api/v0/repo/gc` },
    ]
    for (const { route, url } of probes) {
      const res = await fetch(url, { method: "POST" })
      assert.notEqual(
        res.status,
        403,
        `loopback must not be forbidden on ${route}`,
      )
      assert.equal(res.status, 200, `loopback should succeed on ${route}`)
    }
  })

  it("non-loopback caller without token gets 403 on all gated routes", async (t) => {
    if (!lanIp) {
      t.skip("no non-loopback IPv4 interface available on this host")
      return
    }
    const lanBase = `http://${lanIp}:${server["cfg"].port}`
    for (const route of GATED_ROUTES) {
      const url =
        route === "/api/v0/repo/gc"
          ? `${lanBase}${route}`
          : `${lanBase}${route}?arg=bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
      const res = await fetch(url, { method: "POST" })
      assert.equal(res.status, 403, `non-loopback must be 403 on ${route}`)
      const json = (await res.json()) as { error: string }
      assert.equal(json.error, "forbidden", `error code mismatch on ${route}`)
    }
  })

  it("non-loopback caller with wrong token gets 403", async (t) => {
    if (!lanIp) {
      t.skip("no non-loopback IPv4 interface available on this host")
      return
    }
    const lanBase = `http://${lanIp}:${server["cfg"].port}`
    for (const route of GATED_ROUTES) {
      const url =
        route === "/api/v0/repo/gc"
          ? `${lanBase}${route}`
          : `${lanBase}${route}?arg=bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
      const res = await fetch(url, {
        method: "POST",
        headers: { "x-coc-ipfs-admin-token": "totally-wrong-token" },
      })
      assert.equal(res.status, 403, `wrong token must be 403 on ${route}`)
    }
  })

  it("non-loopback caller with correct token succeeds on all gated routes", async (t) => {
    if (!lanIp) {
      t.skip("no non-loopback IPv4 interface available on this host")
      return
    }
    const lanBase = `http://${lanIp}:${server["cfg"].port}`
    // Real CIDs so the handler bodies (not just the gate) succeed:
    // pin/rm needs a pinned CID, block/rm needs a present block.
    const pinCid = await addFile(`token-pin-${Math.random()}`)
    await fetch(`${loopbackBase}/api/v0/pin/add?arg=${pinCid}`, {
      method: "POST",
    })
    const blockCid = await addFile(`token-block-${Math.random()}`)

    const probes: Array<{ route: string; url: string }> = [
      { route: "/api/v0/pin/rm", url: `${lanBase}/api/v0/pin/rm?arg=${pinCid}` },
      { route: "/api/v0/block/rm", url: `${lanBase}/api/v0/block/rm?arg=${blockCid}` },
      { route: "/api/v0/repo/gc", url: `${lanBase}/api/v0/repo/gc` },
    ]
    for (const { route, url } of probes) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "x-coc-ipfs-admin-token": "e2e-secret-token-abc" },
      })
      assert.equal(
        res.status,
        200,
        `correct token must succeed on ${route}, got ${res.status}`,
      )
    }
  })
})

describe("IPFS E2E Extended — Admin Auth Gate (no token configured)", () => {
  // Without adminAuthToken configured, the gate is loopback-only: a
  // non-loopback caller is always 403 regardless of any header it sends.
  const lanIp = firstNonLoopbackIPv4()
  let tmpDir: string
  let server: IpfsHttpServer

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-notoken-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)
    const port = randomPort()
    server = new IpfsHttpServer(
      { bind: "0.0.0.0", port, storageDir: tmpDir, nodeId: "e2e-notoken-node" },
      store,
      unixfs,
    )
    server.start()
    await new Promise((r) => setTimeout(r, 200))
  })

  after(async () => {
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("non-loopback caller is 403 even when presenting a token header", async (t) => {
    if (!lanIp) {
      t.skip("no non-loopback IPv4 interface available on this host")
      return
    }
    const lanBase = `http://${lanIp}:${server["cfg"].port}`
    const res = await fetch(`${lanBase}/api/v0/repo/gc`, {
      method: "POST",
      headers: { "x-coc-ipfs-admin-token": "anything" },
    })
    assert.equal(res.status, 403)
  })

  it("loopback caller still succeeds with no token configured", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server["cfg"].port}/api/v0/repo/gc`,
      { method: "POST" },
    )
    assert.equal(res.status, 200)
  })
})

// ── 2. Gateway HTTP Range + HEAD ──────────────────────────────────────

describe("IPFS E2E Extended — Gateway Range + HEAD", () => {
  let tmpDir: string
  let server: IpfsHttpServer
  let base: string
  let cid: string
  // 64 distinct bytes so partial slices are unambiguous.
  const content = Array.from({ length: 64 }, (_, i) =>
    String.fromCharCode(65 + (i % 26)),
  ).join("")

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-range-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)
    const port = randomPort()
    base = `http://127.0.0.1:${port}`
    server = new IpfsHttpServer(
      { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "e2e-range-node" },
      store,
      unixfs,
    )
    server.start()
    await new Promise((r) => setTimeout(r, 200))

    const { body, contentType } = multipart("range.txt", content)
    const res = await fetch(`${base}/api/v0/add`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const json = (await res.json()) as Record<string, string>
    cid = json.Hash
  })

  after(async () => {
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("Range bytes=N-M returns 206 with the exact partial body", async () => {
    const res = await fetch(`${base}/ipfs/${cid}`, {
      headers: { Range: "bytes=10-19" },
    })
    assert.equal(res.status, 206)
    assert.equal(
      res.headers.get("content-range"),
      `bytes 10-19/${content.length}`,
    )
    assert.equal(res.headers.get("accept-ranges"), "bytes")
    const text = await res.text()
    assert.equal(text, content.slice(10, 20))
    assert.equal(text.length, 10)
  })

  it("open-ended Range bytes=N- returns 206 to end of file", async () => {
    const res = await fetch(`${base}/ipfs/${cid}`, {
      headers: { Range: "bytes=50-" },
    })
    assert.equal(res.status, 206)
    assert.equal(
      res.headers.get("content-range"),
      `bytes 50-${content.length - 1}/${content.length}`,
    )
    assert.equal(await res.text(), content.slice(50))
  })

  it("suffix Range bytes=-N returns 206 with the last N bytes", async () => {
    const res = await fetch(`${base}/ipfs/${cid}`, {
      headers: { Range: "bytes=-8" },
    })
    assert.equal(res.status, 206)
    assert.equal(await res.text(), content.slice(-8))
  })

  it("unsatisfiable Range (start past EOF) returns 416", async () => {
    const res = await fetch(`${base}/ipfs/${cid}`, {
      headers: { Range: `bytes=${content.length + 100}-` },
    })
    assert.equal(res.status, 416)
    assert.equal(
      res.headers.get("content-range"),
      `bytes */${content.length}`,
    )
  })

  it("HEAD mirrors GET headers without a body", async () => {
    const getRes = await fetch(`${base}/ipfs/${cid}`)
    const getBody = await getRes.text()
    assert.equal(getRes.status, 200)

    const headRes = await fetch(`${base}/ipfs/${cid}`, { method: "HEAD" })
    assert.equal(headRes.status, 200)
    // HEAD must carry the same framing headers as GET...
    assert.equal(
      headRes.headers.get("content-length"),
      getRes.headers.get("content-length"),
    )
    assert.equal(
      headRes.headers.get("content-type"),
      getRes.headers.get("content-type"),
    )
    assert.equal(
      headRes.headers.get("accept-ranges"),
      getRes.headers.get("accept-ranges"),
    )
    assert.equal(
      headRes.headers.get("content-length"),
      String(getBody.length),
    )
    // ...but no body.
    const headBody = await headRes.text()
    assert.equal(headBody, "")
  })

  it("HEAD on a missing CID returns 404 with no body", async () => {
    // A genuine, fully-decodable raw-block CID whose bytes were never
    // stored — exercises the 404 not-found path (not the 400 invalid-CID
    // path that a malformed CID string would hit).
    const missing = await unstoredRawCid(
      new TextEncoder().encode(`never-stored-${Math.random()}`),
    )
    const res = await fetch(`${base}/ipfs/${missing}`, { method: "HEAD" })
    assert.equal(res.status, 404)
    assert.equal(await res.text(), "")
  })
})

// ── 3. Concurrent Uploads ─────────────────────────────────────────────

describe("IPFS E2E Extended — Concurrent Uploads", () => {
  let tmpDir: string
  let server: IpfsHttpServer
  let base: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-concurrent-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)
    const port = randomPort()
    base = `http://127.0.0.1:${port}`
    server = new IpfsHttpServer(
      { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "e2e-concurrent-node" },
      store,
      unixfs,
    )
    server.start()
    await new Promise((r) => setTimeout(r, 200))
  })

  after(async () => {
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("10 parallel /api/v0/add calls each yield a unique, retrievable CID", async () => {
    const N = 10
    const contents = Array.from(
      { length: N },
      (_, i) => `concurrent-upload-payload-#${i}-${Math.random().toString(36).slice(2)}`,
    )

    // Fire all uploads in parallel.
    const addResults = await Promise.all(
      contents.map(async (content, i) => {
        const { body, contentType } = multipart(`file-${i}.txt`, content)
        const res = await fetch(`${base}/api/v0/add`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        })
        assert.equal(res.status, 200, `upload ${i} should succeed`)
        const json = (await res.json()) as Record<string, string>
        assert.ok(json.Hash, `upload ${i} must return a Hash`)
        return json.Hash
      }),
    )

    // Distinct contents → distinct CIDs.
    const uniqueCids = new Set(addResults)
    assert.equal(
      uniqueCids.size,
      N,
      `expected ${N} unique CIDs, got ${uniqueCids.size}`,
    )

    // Each CID independently retrievable with the exact original bytes.
    await Promise.all(
      addResults.map(async (cid, i) => {
        const res = await fetch(`${base}/api/v0/cat?arg=${cid}`, {
          method: "POST",
        })
        assert.equal(res.status, 200, `cat of upload ${i} should succeed`)
        assert.equal(await res.text(), contents[i], `cat ${i} content mismatch`)
      }),
    )
  })

  it("identical concurrent uploads dedupe to the same CID", async () => {
    // Content-addressing: the same bytes must always yield the same CID,
    // even across simultaneous uploads.
    const content = "identical-payload-for-dedup-check"
    const cids = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const { body, contentType } = multipart("dup.txt", content)
        const res = await fetch(`${base}/api/v0/add`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        })
        const json = (await res.json()) as Record<string, string>
        return json.Hash
      }),
    )
    assert.equal(new Set(cids).size, 1, "identical content must share one CID")
  })
})

// ── 4. MFS Round-Trip ─────────────────────────────────────────────────

describe("IPFS E2E Extended — MFS Round-Trip", () => {
  let tmpDir: string
  let server: IpfsHttpServer
  let base: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-mfs-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)
    const mfs = new IpfsMfs(store, unixfs)
    const port = randomPort()
    base = `http://127.0.0.1:${port}`
    server = new IpfsHttpServer(
      { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "e2e-mfs-node" },
      store,
      unixfs,
    )
    server.attachSubsystems({ mfs })
    server.start()
    await new Promise((r) => setTimeout(r, 200))
  })

  after(async () => {
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("full lifecycle: mkdir → write → read → ls → stat → rm", async () => {
    const dir = "/e2e-roundtrip"
    const filePath = `${dir}/doc.txt`
    const payload = "mfs round-trip payload"

    // mkdir (with parents)
    const mkdirRes = await fetch(
      `${base}/api/v0/files/mkdir?arg=${dir}&parents=true`,
      { method: "POST" },
    )
    assert.equal(mkdirRes.status, 200, "mkdir should succeed")

    // write
    const writeRes = await fetch(
      `${base}/api/v0/files/write?arg=${filePath}&create=true`,
      { method: "POST", body: new TextEncoder().encode(payload) },
    )
    assert.equal(writeRes.status, 200, "write should succeed")

    // read back
    const readRes = await fetch(
      `${base}/api/v0/files/read?arg=${filePath}`,
      { method: "POST" },
    )
    assert.equal(readRes.status, 200, "read should succeed")
    assert.equal(await readRes.text(), payload, "read content mismatch")

    // ls the directory — file must appear
    const lsRes = await fetch(`${base}/api/v0/files/ls?arg=${dir}`, {
      method: "POST",
    })
    assert.equal(lsRes.status, 200, "ls should succeed")
    const lsJson = (await lsRes.json()) as {
      Entries: Array<{ Name: string; Type: number; Size: number }>
    }
    const entry = lsJson.Entries.find((e) => e.Name === "doc.txt")
    assert.ok(entry, "ls must list the written file")
    assert.equal(entry!.Type, 0, "file entry Type must be 0")

    // stat the file — kubo-compat PascalCase shape
    const statRes = await fetch(
      `${base}/api/v0/files/stat?arg=${filePath}`,
      { method: "POST" },
    )
    assert.equal(statRes.status, 200, "stat should succeed")
    const statJson = (await statRes.json()) as Record<string, unknown>
    assert.equal(statJson.Type, "file")
    assert.equal(statJson.Size, payload.length, "stat Size must match payload")
    assert.ok(statJson.Hash, "stat must return a Hash")

    // rm the file
    const rmRes = await fetch(
      `${base}/api/v0/files/rm?arg=${filePath}`,
      { method: "POST" },
    )
    assert.equal(rmRes.status, 200, "rm should succeed")

    // ls again — directory must be empty
    const lsAfterRes = await fetch(`${base}/api/v0/files/ls?arg=${dir}`, {
      method: "POST",
    })
    assert.equal(lsAfterRes.status, 200)
    const lsAfterJson = (await lsAfterRes.json()) as {
      Entries: Array<{ Name: string }>
    }
    assert.equal(
      lsAfterJson.Entries.length,
      0,
      "directory must be empty after rm",
    )

    // read of the removed file → 404
    const readGoneRes = await fetch(
      `${base}/api/v0/files/read?arg=${filePath}`,
      { method: "POST" },
    )
    assert.equal(readGoneRes.status, 404, "read of removed file must be 404")
  })

  it("nested directories: mkdir -p then write deep, ls each level", async () => {
    const deep = "/lvl1/lvl2/lvl3"
    const mkdirRes = await fetch(
      `${base}/api/v0/files/mkdir?arg=${deep}&parents=true`,
      { method: "POST" },
    )
    assert.equal(mkdirRes.status, 200)

    const writeRes = await fetch(
      `${base}/api/v0/files/write?arg=${deep}/nested.txt&create=true`,
      { method: "POST", body: new TextEncoder().encode("deep file") },
    )
    assert.equal(writeRes.status, 200)

    // Each intermediate level should be listable.
    for (const level of ["/lvl1", "/lvl1/lvl2", "/lvl1/lvl2/lvl3"]) {
      const res = await fetch(`${base}/api/v0/files/ls?arg=${level}`, {
        method: "POST",
      })
      assert.equal(res.status, 200, `ls ${level} should succeed`)
    }

    const readRes = await fetch(
      `${base}/api/v0/files/read?arg=${deep}/nested.txt`,
      { method: "POST" },
    )
    assert.equal(readRes.status, 200)
    assert.equal(await readRes.text(), "deep file")
  })
})

// ── 5. Pubsub Round-Trip ──────────────────────────────────────────────

describe("IPFS E2E Extended — Pubsub Round-Trip", () => {
  let tmpDir: string
  let server: IpfsHttpServer
  let base: string
  let pubsub: IpfsPubsub

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-e2e-pubsub-"))
    const store = new IpfsBlockstore(tmpDir)
    await store.init()
    const unixfs = new UnixFsBuilder(store)
    pubsub = new IpfsPubsub({ nodeId: "e2e-pubsub-node" })
    pubsub.start()
    const port = randomPort()
    base = `http://127.0.0.1:${port}`
    server = new IpfsHttpServer(
      { bind: "127.0.0.1", port, storageDir: tmpDir, nodeId: "e2e-pubsub-node" },
      store,
      unixfs,
    )
    server.attachSubsystems({ pubsub })
    server.start()
    await new Promise((r) => setTimeout(r, 200))
  })

  after(async () => {
    pubsub.stop()
    await server.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("publish via HTTP delivers the message to a local subscriber", async () => {
    const topic = "e2e-roundtrip-topic"
    const received: string[] = []
    const handler = (msg: { data: Uint8Array }) => {
      received.push(new TextDecoder().decode(msg.data))
    }
    pubsub.subscribe(topic, handler)
    try {
      const res = await fetch(
        `${base}/api/v0/pubsub/pub?arg=${topic}`,
        { method: "POST", body: new TextEncoder().encode("round-trip message") },
      )
      assert.equal(res.status, 200)
      const json = (await res.json()) as { ok: boolean }
      assert.equal(json.ok, true)
      // Subscribers run synchronously inside publish() in this impl.
      assert.equal(received.length, 1, "subscriber must receive exactly one")
      assert.equal(received[0], "round-trip message")
    } finally {
      pubsub.unsubscribe(topic, handler)
    }
  })

  it("multiple subscribers on one topic all receive the publish", async () => {
    const topic = "e2e-fanout-topic"
    const seenA: string[] = []
    const seenB: string[] = []
    const handlerA = (msg: { data: Uint8Array }) =>
      seenA.push(new TextDecoder().decode(msg.data))
    const handlerB = (msg: { data: Uint8Array }) =>
      seenB.push(new TextDecoder().decode(msg.data))
    pubsub.subscribe(topic, handlerA)
    pubsub.subscribe(topic, handlerB)
    try {
      const res = await fetch(
        `${base}/api/v0/pubsub/pub?arg=${topic}`,
        { method: "POST", body: new TextEncoder().encode("fanout payload") },
      )
      assert.equal(res.status, 200)
      assert.deepEqual(seenA, ["fanout payload"])
      assert.deepEqual(seenB, ["fanout payload"])
    } finally {
      pubsub.unsubscribe(topic, handlerA)
      pubsub.unsubscribe(topic, handlerB)
    }
  })

  it("pubsub/ls reports the active topic, and drops it after unsubscribe", async () => {
    const topic = "e2e-ls-lifecycle-topic"
    const handler = () => {}
    pubsub.subscribe(topic, handler)

    const lsRes = await fetch(`${base}/api/v0/pubsub/ls`, { method: "POST" })
    assert.equal(lsRes.status, 200)
    const lsJson = (await lsRes.json()) as { Strings: string[] }
    assert.ok(
      lsJson.Strings.includes(topic),
      "ls must list the subscribed topic",
    )

    pubsub.unsubscribe(topic, handler)
    const lsAfterRes = await fetch(`${base}/api/v0/pubsub/ls`, {
      method: "POST",
    })
    const lsAfterJson = (await lsAfterRes.json()) as { Strings: string[] }
    assert.ok(
      !lsAfterJson.Strings.includes(topic),
      "ls must drop the topic after the last unsubscribe",
    )
  })

  it("publish to a topic with no subscribers still returns 200", async () => {
    const res = await fetch(
      `${base}/api/v0/pubsub/pub?arg=e2e-no-subscribers`,
      { method: "POST", body: new TextEncoder().encode("into the void") },
    )
    assert.equal(res.status, 200)
  })
})
