import test from "node:test"
import assert from "node:assert/strict"
import { EquivocationDetector } from "./bft.ts"
import type { Hex } from "./blockchain-types.ts"

/**
 * PR-1C: Equivocation evidence cache 自清 + sliding-window
 *
 * 2026-05-10 N=5 attempt #2 fingerprint: during chain freeze, clearEvidenceBefore
 * is never called (no finalize). A single validator's evidence array fills to
 * the per-validator cap=100, after which new evidence is silently NOT pushed
 * (kept in `evidence` array). The validator's cap stays full forever; later
 * recovery's evidence cleanup only frees the slot when finalize advances past
 * the height — but because the freeze stopped finalization, that doesn't happen.
 *
 * Fix:
 *   1. When per-validator cap reached, evict the OLDEST entry from the same
 *      validator and push the new one (sliding window). Recent evidence is
 *      strictly more useful than ancient evidence for slashing decisions.
 *   2. Add `getStats()` for monitoring (size, dropCount, perValidator counts).
 *   3. Add `pruneByMaxHeight(maxHeight, keep)` that retains only the `keep`
 *      most-recent heights — usable by external watchdogs to bound memory
 *      even when finalize hasn't advanced.
 */

function mkHash(suffix: number): Hex {
  return ("0x" + suffix.toString(16).padStart(64, "0")) as Hex
}

test("PR-1C: per-validator cap evicts OLDEST entry of same validator (sliding window)", () => {
  // Cap of 3 for testability. Push 5 conflicting votes for the same validator.
  // Old behavior: first 3 stored, last 2 dropped → array stays at the OLDEST 3.
  // PR-1C behavior: array slides → keeps the NEWEST 3 (most recent are most useful).
  const det = new EquivocationDetector(100, 1000, 3)
  const v = "0xvalidator1"

  // Generate 5 equivocation events at different heights for the same validator
  for (let h = 1; h <= 5; h++) {
    det.recordVote(v, BigInt(h), "prepare", mkHash(h * 10), ("0xsig" + h) as Hex)
    det.recordVote(v, BigInt(h), "prepare", mkHash(h * 10 + 1), ("0xsig" + h + "b") as Hex)
  }

  const ev = det.getEvidenceFor(v)
  assert.equal(ev.length, 3, "per-validator cap respected")
  // Sliding window keeps the NEWEST: heights 3, 4, 5 (not 1, 2, 3)
  const heights = ev.map((e) => e.height).sort((a, b) => Number(a - b))
  assert.deepEqual(heights, [3n, 4n, 5n], "newest entries retained")
})

test("PR-1C: getStats exposes size + per-validator counts", () => {
  const det = new EquivocationDetector(100, 1000, 100)

  // Two validators, two evicocations each
  for (const v of ["0xa", "0xb"]) {
    det.recordVote(v, 10n, "prepare", mkHash(1))
    det.recordVote(v, 10n, "prepare", mkHash(2))
    det.recordVote(v, 11n, "commit", mkHash(3))
    det.recordVote(v, 11n, "commit", mkHash(4))
  }

  const stats = det.getStats()
  assert.equal(stats.totalEvidence, 4, "4 total evidence entries")
  assert.equal(stats.uniqueValidators, 2)
  assert.equal(stats.perValidator["0xa"], 2)
  assert.equal(stats.perValidator["0xb"], 2)
})

test("PR-1C: pruneByMaxHeight retains only `keep` most-recent heights", () => {
  const det = new EquivocationDetector(100, 1000, 100)
  const v = "0xv1"

  // Conflicting votes at heights 1..10
  for (let h = 1; h <= 10; h++) {
    det.recordVote(v, BigInt(h), "prepare", mkHash(h * 10))
    det.recordVote(v, BigInt(h), "prepare", mkHash(h * 10 + 1))
  }
  assert.equal(det.getEvidence().length, 10, "10 evidence entries before prune")

  // Keep only the 3 most-recent heights worth of evidence
  const removed = det.pruneByMaxHeight(3)
  assert.equal(removed, 7, "7 entries pruned (10 - 3)")

  const remaining = det.getEvidence()
  assert.equal(remaining.length, 3)
  const heights = remaining.map((e) => e.height).sort((a, b) => Number(a - b))
  assert.deepEqual(heights, [8n, 9n, 10n], "newest 3 heights retained")
})

test("PR-1C: pruneByMaxHeight is a no-op when total <= keep", () => {
  const det = new EquivocationDetector(100, 1000, 100)
  det.recordVote("0xv", 1n, "prepare", mkHash(1))
  det.recordVote("0xv", 1n, "prepare", mkHash(2))
  det.recordVote("0xv", 2n, "prepare", mkHash(3))
  det.recordVote("0xv", 2n, "prepare", mkHash(4))

  const removed = det.pruneByMaxHeight(10)
  assert.equal(removed, 0)
  assert.equal(det.getEvidence().length, 2)
})

test("PR-1C: long-running stress — 1000 conflicting votes settle into bounded cache", () => {
  // Simulate a multi-hour run with hostile validators repeatedly equivocating.
  // Without PR-1C: array grows past cap, oldest-from-most-active stays evicted,
  // memory & CPU stable but old evidence pinned.
  // With PR-1C: sliding-window means newest evidence always wins.
  const det = new EquivocationDetector(100, 1000, 50)

  for (let h = 1; h <= 1000; h++) {
    det.recordVote("0xattacker", BigInt(h), "prepare", mkHash(h * 10))
    det.recordVote("0xattacker", BigInt(h), "prepare", mkHash(h * 10 + 1))
  }

  const ev = det.getEvidenceFor("0xattacker")
  assert.equal(ev.length, 50, "respects per-validator cap of 50")
  // Should be the NEWEST 50 heights (951..1000)
  const heights = ev.map((e) => Number(e.height))
  assert.equal(Math.min(...heights), 951, "oldest retained = h-49")
  assert.equal(Math.max(...heights), 1000, "newest retained = h")
})

test("PR-1C: clearEvidenceBefore still works as before (regression check)", () => {
  // Existing semantics preserved: clearEvidenceBefore removes evidence
  // with height < threshold and keeps the rest. Used by Phase H16 on every
  // finalize. PR-1C does NOT change this method.
  const det = new EquivocationDetector(100, 1000, 100)
  det.recordVote("0xv1", 5n, "prepare", mkHash(1))
  det.recordVote("0xv1", 5n, "prepare", mkHash(2))
  det.recordVote("0xv1", 8n, "commit", mkHash(3))
  det.recordVote("0xv1", 8n, "commit", mkHash(4))

  const removed = det.clearEvidenceBefore(7n)
  assert.equal(removed, 1, "h=5 evidence removed")
  assert.equal(det.getEvidenceFor("0xv1").length, 1)
  assert.equal(det.getEvidenceFor("0xv1")[0].height, 8n)
})

test("PR-1C: getStats droppedTotal counts incoming votes silently dropped pre-cap", () => {
  // Before PR-1C, hitting per-validator cap silently dropped new evidence
  // (logged a warn but no metric). PR-1C: cap-eviction means we never DROP
  // legitimate evidence — droppedTotal stays at 0 in normal operation.
  const det = new EquivocationDetector(100, 1000, 5)

  for (let h = 1; h <= 20; h++) {
    det.recordVote("0xv", BigInt(h), "prepare", mkHash(h * 10))
    det.recordVote("0xv", BigInt(h), "prepare", mkHash(h * 10 + 1))
  }

  const stats = det.getStats()
  // With sliding window, no drops: every conflict either was added or
  // evicted an older entry. Total entries = cap (5).
  assert.equal(stats.totalEvidence, 5)
  assert.equal(stats.droppedTotal, 0, "no legitimate evidence is dropped")
})
