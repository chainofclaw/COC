import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { PendingChallengeStore, type PendingChallengeRecord } from "./pending-challenge-store.ts"

function sampleRecord(overrides: Partial<PendingChallengeRecord> = {}): PendingChallengeRecord {
  return {
    commitHash: `0x${"11".repeat(32)}`,
    salt: `0x${"22".repeat(32)}`,
    targetNodeId: `0x${"33".repeat(32)}`,
    faultType: 4,
    evidenceLeafHash: `0x${"44".repeat(32)}`,
    evidenceData: "0x1234",
    challengerSig: "0xabcd",
    state: "opening",
    createdAtMs: 1_700_000_000_000,
    openTxHash: `0x${"55".repeat(32)}`,
    ...overrides,
  }
}

test("pending challenge store persists and reloads records", () => {
  const dir = mkdtempSync(join(tmpdir(), "coc-pending-challenge-store-"))
  const path = join(dir, "pending-challenges.json")

  const store = new PendingChallengeStore(path)
  store.upsert(sampleRecord())

  const restored = new PendingChallengeStore(path)
  assert.equal(restored.size, 1)
  assert.deepEqual(restored.list(), [sampleRecord()])
})

test("pending challenge store overwrites by commit hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "coc-pending-challenge-store-"))
  const path = join(dir, "pending-challenges.json")

  const store = new PendingChallengeStore(path)
  store.upsert(sampleRecord())
  store.upsert(sampleRecord({
    challengeId: `0x${"66".repeat(32)}`,
    state: "committed",
    openTxHash: `0x${"77".repeat(32)}`,
  }))

  const restored = new PendingChallengeStore(path)
  const record = restored.get(`0x${"11".repeat(32)}`)
  assert.ok(record)
  assert.equal(record?.state, "committed")
  assert.equal(record?.challengeId, `0x${"66".repeat(32)}`)
  assert.equal(record?.openTxHash, `0x${"77".repeat(32)}`)
})

test("pending challenge store removes records and syncs disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "coc-pending-challenge-store-"))
  const path = join(dir, "pending-challenges.json")

  const store = new PendingChallengeStore(path)
  store.upsert(sampleRecord())
  assert.equal(store.remove(`0x${"11".repeat(32)}`), true)
  assert.equal(store.size, 0)

  const raw = readFileSync(path, "utf-8")
  assert.equal(raw.trim(), "[]")
})
