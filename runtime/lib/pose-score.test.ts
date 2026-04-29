import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { verifiedStorageBytesFor } from "./pose-score.ts"

describe("verifiedStorageBytesFor (Phase C2.3)", () => {
  it("prefers chunkSize when both fields are present", () => {
    // FF-on path would normally only set chunkSize; the mixed case
    // exists to guard against a future regression where a caller
    // populates both (e.g. during a migration) — we must never fall
    // back to fileSize when chunkSize is the authoritative figure.
    const bytes = verifiedStorageBytesFor({ chunkSize: 262_144, fileSize: 4_194_304 })
    assert.equal(bytes, 262_144)
  })

  it("falls back to fileSize when chunkSize is undefined (legacy path)", () => {
    const bytes = verifiedStorageBytesFor({ fileSize: 1024 })
    assert.equal(bytes, 1024)
  })

  it("returns chunkSize=0 as undefined (zero bytes shouldn't credit)", () => {
    // A zero-byte chunk would only happen for pathological UnixFS
    // inputs (empty file); scoring should not give credit for
    // "proving" nothing exists.
    const bytes = verifiedStorageBytesFor({ chunkSize: 0, fileSize: 500 })
    // fileSize fallback wins because chunkSize is 0 (not > 0).
    assert.equal(bytes, 500)
  })

  it("returns undefined when both fields are missing or zero", () => {
    assert.equal(verifiedStorageBytesFor({}), undefined)
    assert.equal(verifiedStorageBytesFor({ chunkSize: 0 }), undefined)
    assert.equal(verifiedStorageBytesFor({ fileSize: 0 }), undefined)
    assert.equal(verifiedStorageBytesFor({ chunkSize: 0, fileSize: 0 }), undefined)
  })

  it("returns undefined when target itself is null/undefined", () => {
    assert.equal(verifiedStorageBytesFor(null), undefined)
    assert.equal(verifiedStorageBytesFor(undefined), undefined)
  })

  it("rejects negative sizes (treated as missing)", () => {
    // Shouldn't happen under normal flow, but if some future bug
    // emits a negative, we must not credit a negative amount.
    const bytes = verifiedStorageBytesFor({ chunkSize: -1, fileSize: -1 })
    assert.equal(bytes, undefined)
  })
})
