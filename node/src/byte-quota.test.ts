import { test } from "node:test"
import assert from "node:assert/strict"
import { ByteQuota } from "./byte-quota.ts"

test("ByteQuota — per-key reservation under budget succeeds and tracks usage", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  const r = q.tryReserve("1.2.3.4", 400)
  assert.equal(r.ok, true)
  assert.equal(q.used("1.2.3.4"), 400)
  assert.equal(q.globalBytes(), 400)
})

test("ByteQuota — per-key budget exhaustion returns ok:false with reason", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  q.tryReserve("1.2.3.4", 600).reservation!.commit(600)
  const r = q.tryReserve("1.2.3.4", 500)
  assert.equal(r.ok, false)
  assert.equal(r.reason, "per-key")
  assert.equal(r.remaining, 400)
})

test("ByteQuota — global budget caps total across distinct keys (Sybil defense)", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 2_500 })
  q.tryReserve("ip-a", 1_000).reservation!.commit(1_000)
  q.tryReserve("ip-b", 1_000).reservation!.commit(1_000)
  // ip-c still under per-key, but global is at 2000/2500 → only 500 fits
  const r1 = q.tryReserve("ip-c", 600)
  assert.equal(r1.ok, false)
  assert.equal(r1.reason, "global")
  assert.equal(r1.remaining, 500)
  const r2 = q.tryReserve("ip-c", 500)
  assert.equal(r2.ok, true)
})

test("ByteQuota — commit() reconciles charge to actual bytes (over-declared refunded)", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  const r = q.tryReserve("ip-x", 800)
  assert.equal(r.ok, true)
  // Actual upload was only 300 bytes — should refund 500
  r.reservation!.commit(300)
  assert.equal(q.used("ip-x"), 300)
  assert.equal(q.globalBytes(), 300)
})

test("ByteQuota — commit() handles actual > declared (Content-Length lied small)", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  const r = q.tryReserve("ip-x", 200)
  r.reservation!.commit(900)
  assert.equal(q.used("ip-x"), 900)
})

test("ByteQuota — refund() releases entire reservation (upload failed)", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  const r = q.tryReserve("ip-x", 700)
  r.reservation!.refund()
  assert.equal(q.used("ip-x"), 0)
  assert.equal(q.globalBytes(), 0)
})

test("ByteQuota — commit() / refund() idempotent — second call is a no-op", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  const r = q.tryReserve("ip-x", 500)
  r.reservation!.commit(500)
  r.reservation!.commit(999) // ignored
  r.reservation!.refund() // ignored
  assert.equal(q.used("ip-x"), 500)
})

test("ByteQuota — window rolls over and bucket is freed", async () => {
  const q = new ByteQuota({ windowMs: 50, perKeyMax: 1_000, globalMax: 10_000 })
  q.tryReserve("ip-x", 1_000).reservation!.commit(1_000)
  assert.equal(q.tryReserve("ip-x", 1).ok, false)
  await new Promise((r) => setTimeout(r, 70))
  // Window rolled — fresh budget
  assert.equal(q.tryReserve("ip-x", 1_000).ok, true)
})

test("ByteQuota — negative / non-finite declaredBytes is rejected", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 10_000 })
  assert.equal(q.tryReserve("ip", -1).ok, false)
  assert.equal(q.tryReserve("ip", Number.NaN).ok, false)
  assert.equal(q.tryReserve("ip", Number.POSITIVE_INFINITY).ok, false)
})

test("ByteQuota — COC_IPFS_QUOTA_DISABLED=1 bypasses all checks", () => {
  process.env.COC_IPFS_QUOTA_DISABLED = "1"
  try {
    const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1, globalMax: 1 })
    const r = q.tryReserve("ip", 1_000_000)
    assert.equal(r.ok, true)
    // commit/refund are no-ops in bypass mode but must not throw
    r.reservation!.commit(1_000_000)
    r.reservation!.refund()
    assert.equal(q.used("ip"), 0)
  } finally {
    delete process.env.COC_IPFS_QUOTA_DISABLED
  }
})

test("ByteQuota — maxKeys cap prevents memory exhaustion via distinct keys", () => {
  const q = new ByteQuota({ windowMs: 60_000, perKeyMax: 1_000, globalMax: 1_000_000, maxKeys: 5 })
  for (let i = 0; i < 5; i++) {
    assert.equal(q.tryReserve(`ip-${i}`, 100).ok, true)
  }
  // 6th distinct key — over cap, with no expired entries to evict → reject
  const r = q.tryReserve("ip-overflow", 100)
  assert.equal(r.ok, false)
  assert.equal(r.reason, "per-key")
})
