import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readBoundedBody, MAX_RUNTIME_POSE_BODY } from "./pose-body-reader.ts";

// #292: end-to-end test of the bounded body reader. Pre-fix coc-node.ts's
// /pose/* POSTs accumulated the request body with no size cap — a
// multi-GB body OOMed the process. This helper now enforces a 1 MB cap
// (matching node/src/pose-http.ts MAX_POSE_BODY) so the runtime path is
// symmetric with the HTTP-server path.
//
// We spin up a tiny http.Server that mounts readBoundedBody on POST /,
// then exercise: (a) small body roundtrips, (b) over-cap rejects 413,
// (c) at-cap accepts, (d) callback never fires on over-cap.

test("readBoundedBody — small body roundtrips", async (t) => {
  let received = ""
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404)
      res.end()
      return
    }
    readBoundedBody(req, res, (body) => {
      received = body
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, len: body.length }))
    })
  })
  server.listen(0)
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const body = JSON.stringify({ hello: "world" })
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  })
  assert.equal(res.status, 200)
  const data = await res.json() as { ok: boolean; len: number }
  assert.equal(data.ok, true)
  assert.equal(data.len, body.length)
  assert.equal(received, body)
})

test("readBoundedBody — body exactly at cap accepts", async (t) => {
  let callbackFired = false
  const cap = 1024 // small cap so tests stay fast
  const server = http.createServer((req, res) => {
    readBoundedBody(req, res, (body) => {
      callbackFired = true
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, len: body.length }))
    }, cap)
  })
  server.listen(0)
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  // Body of exactly `cap` bytes — must accept (boundary is `> cap` not `>= cap`).
  const body = "x".repeat(cap)
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST", body,
  })
  assert.equal(res.status, 200)
  const data = await res.json() as { ok: boolean; len: number }
  assert.equal(data.len, cap)
  assert.equal(callbackFired, true, "callback must fire at exactly cap bytes")
})

test("readBoundedBody — body over cap rejects 413, callback never fires", async (t) => {
  let callbackFired = false
  const cap = 1024
  const server = http.createServer((req, res) => {
    readBoundedBody(req, res, (_body) => {
      callbackFired = true
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    }, cap)
  })
  server.listen(0)
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  // 2x cap — must reject with 413, callback must NOT fire.
  const body = "x".repeat(cap * 2)
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST", body,
  })
  assert.equal(res.status, 413, "over-cap body must be 413, not 200")
  const data = await res.json() as { error?: string }
  assert.match(data.error ?? "", /body too large/i,
    `error must say "body too large", got ${JSON.stringify(data)}`)
  // Give the server a brief moment to settle (no callback should have fired).
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(callbackFired, false,
    "KEY invariant: callback must NEVER fire when body exceeds cap (this is the DoS gate)")
})

test("readBoundedBody — default cap is 1 MB (MAX_RUNTIME_POSE_BODY)", () => {
  assert.equal(MAX_RUNTIME_POSE_BODY, 1024 * 1024,
    "default cap must match HTTP-side pose-http.ts MAX_POSE_BODY (1 MB) for symmetric DoS protection")
})

test("readBoundedBody — empty body roundtrips with empty string", async (t) => {
  let received: string | null = null
  const server = http.createServer((req, res) => {
    readBoundedBody(req, res, (body) => {
      received = body
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, len: body.length }))
    })
  })
  server.listen(0)
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })
  assert.equal(res.status, 200)
  assert.equal(received, "")
})
