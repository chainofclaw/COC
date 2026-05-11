import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  compareForks,
  selectBestFork,
  shouldSwitchFork,
} from "./fork-choice.ts"
import type { ForkCandidate } from "./fork-choice.ts"
import type { Hex } from "./blockchain-types.ts"

function makeCandidate(overrides: Partial<ForkCandidate> = {}): ForkCandidate {
  return {
    height: 10n,
    tipHash: ("0x" + "aa".repeat(32)) as Hex,
    bftFinalized: false,
    cumulativeWeight: 100n,
    peerId: "peer1",
    ...overrides,
  }
}

describe("compareForks", () => {
  // #176 (PR-1P, 2026-05-12): BFT-finality protects the prefix, not the
  // suffix. A finalized chain at h=5 must NOT block a non-finalized peer
  // at h=10 — that was the bug that left restarted nodes unable to catch
  // a small gap (remote.bftFinalized is always set to false by trySync as
  // a safety measure, so the local-finalized-tip path triggered every time).
  it("#176: shorter BFT-finalized chain does NOT beat taller non-finalized peer", () => {
    const a = makeCandidate({ bftFinalized: true, height: 5n, peerId: "a" })
    const b = makeCandidate({ bftFinalized: false, height: 10n, peerId: "b" })
    const result = compareForks(a, b)
    assert.equal(result.winner, b)
    assert.equal(result.reason, "longer-chain")
  })

  it("BFT-finalized chain at equal-or-greater height wins over non-finalized", () => {
    // Equal height — finalized side still wins.
    const a1 = makeCandidate({ bftFinalized: true, height: 10n, peerId: "a" })
    const b1 = makeCandidate({ bftFinalized: false, height: 10n, peerId: "b" })
    const r1 = compareForks(a1, b1)
    assert.equal(r1.winner, a1)
    assert.equal(r1.reason, "bft-finality")
    // Strictly greater — also finalized side wins.
    const a2 = makeCandidate({ bftFinalized: true, height: 11n, peerId: "a" })
    const b2 = makeCandidate({ bftFinalized: false, height: 10n, peerId: "b" })
    const r2 = compareForks(a2, b2)
    assert.equal(r2.winner, a2)
    assert.equal(r2.reason, "bft-finality")
  })

  it("both BFT finalized -> falls through to height", () => {
    const a = makeCandidate({ bftFinalized: true, height: 10n, peerId: "a" })
    const b = makeCandidate({ bftFinalized: true, height: 12n, peerId: "b" })
    const result = compareForks(a, b)
    assert.equal(result.winner, b)
    assert.equal(result.reason, "longer-chain")
  })

  it("longer chain wins when both not finalized", () => {
    const a = makeCandidate({ height: 15n, peerId: "a" })
    const b = makeCandidate({ height: 10n, peerId: "b" })
    const result = compareForks(a, b)
    assert.equal(result.winner, a)
    assert.equal(result.reason, "longer-chain")
  })

  it("higher weight wins when same height", () => {
    const a = makeCandidate({ height: 10n, cumulativeWeight: 200n, peerId: "a" })
    const b = makeCandidate({ height: 10n, cumulativeWeight: 100n, peerId: "b" })
    const result = compareForks(a, b)
    assert.equal(result.winner, a)
    assert.equal(result.reason, "higher-weight")
  })

  it("lower hash wins as tiebreaker", () => {
    const a = makeCandidate({
      height: 10n,
      cumulativeWeight: 100n,
      tipHash: ("0x" + "11".repeat(32)) as Hex,
      peerId: "a",
    })
    const b = makeCandidate({
      height: 10n,
      cumulativeWeight: 100n,
      tipHash: ("0x" + "ff".repeat(32)) as Hex,
      peerId: "b",
    })
    const result = compareForks(a, b)
    assert.equal(result.winner, a)
    assert.equal(result.reason, "lower-hash")
  })

  it("equal candidates with different peerId use peerId tiebreaker", () => {
    const a = makeCandidate({ peerId: "a" })
    const b = makeCandidate({ peerId: "b" })
    const result = compareForks(a, b)
    assert.equal(result.reason, "lower-peer-id")
    assert.equal(result.winner.peerId, "a")
  })

  it("truly equal candidates return equal reason", () => {
    const a = makeCandidate({ peerId: "same" })
    const b = makeCandidate({ peerId: "same" })
    const result = compareForks(a, b)
    assert.equal(result.reason, "equal")
  })
})

describe("selectBestFork", () => {
  it("returns null for empty list", () => {
    assert.equal(selectBestFork([]), null)
  })

  it("returns single candidate", () => {
    const c = makeCandidate()
    assert.equal(selectBestFork([c]), c)
  })

  it("selects best from multiple candidates", () => {
    const a = makeCandidate({ height: 5n, peerId: "a" })
    const b = makeCandidate({ height: 15n, peerId: "b" })
    const c = makeCandidate({ height: 10n, peerId: "c" })
    const best = selectBestFork([a, b, c])
    assert.equal(best?.peerId, "b")
  })

  // #176 (PR-1P): BFT finality used to unconditionally override height
  // even when the finalized side was strictly shorter. That caused
  // restarted nodes to ignore taller peer chains and never catch up.
  // New invariant: longer chain wins when the finalized side is behind.
  it("#176: BFT finality does NOT override a strictly-taller non-finalized chain", () => {
    const a = makeCandidate({ height: 100n, bftFinalized: false, peerId: "a" })
    const b = makeCandidate({ height: 5n, bftFinalized: true, peerId: "b" })
    const best = selectBestFork([a, b])
    assert.equal(best?.peerId, "a")
  })
})

describe("shouldSwitchFork", () => {
  it("returns null when local is better", () => {
    const local = makeCandidate({ height: 15n, peerId: "local" })
    const remote = makeCandidate({ height: 10n, peerId: "remote" })
    assert.equal(shouldSwitchFork(local, remote), null)
  })

  it("returns choice when remote is better", () => {
    const local = makeCandidate({ height: 10n, peerId: "local" })
    const remote = makeCandidate({ height: 15n, peerId: "remote" })
    const result = shouldSwitchFork(local, remote)
    assert.ok(result)
    assert.equal(result.winner.peerId, "remote")
    assert.equal(result.reason, "longer-chain")
  })

  it("returns null for equal forks", () => {
    const local = makeCandidate({ peerId: "local" })
    const remote = makeCandidate({ peerId: "remote" })
    assert.equal(shouldSwitchFork(local, remote), null)
  })

  it("#176: does NOT switch to BFT-finalized remote that is strictly shorter", () => {
    // Pre-PR-1P: this asserted that a shorter finalized remote beat a
    // taller local chain. Under the new invariant, local longer wins
    // because BFT finality only protects the prefix, not the suffix.
    const local = makeCandidate({ height: 20n, bftFinalized: false, peerId: "local" })
    const remote = makeCandidate({ height: 5n, bftFinalized: true, peerId: "remote" })
    assert.equal(shouldSwitchFork(local, remote), null)
  })

  it("#176: switches to taller non-finalized remote even when local is finalized", () => {
    // This is the bug-fix path: post-restart, local saved tip is
    // BFT-finalized at 71813 but peers are at 71820. With the
    // pre-fix Rule 1 the sync loop never caught up. With the fix,
    // height takes precedence and the snapshot is adopted.
    const local = makeCandidate({ height: 71813n, bftFinalized: true, peerId: "local" })
    const remote = makeCandidate({ height: 71820n, bftFinalized: false, peerId: "remote" })
    const result = shouldSwitchFork(local, remote)
    assert.ok(result, "expected to switch to taller remote chain")
    assert.equal(result.reason, "longer-chain")
    assert.equal(result.winner.peerId, "remote")
  })

  it("high-weight short chain wins over low-weight long chain", () => {
    const local = makeCandidate({ height: 10n, cumulativeWeight: 50n, peerId: "local" })
    const remote = makeCandidate({ height: 10n, cumulativeWeight: 200n, peerId: "remote" })
    const result = shouldSwitchFork(local, remote)
    assert.ok(result)
    assert.equal(result.reason, "higher-weight")
    assert.equal(result.winner.peerId, "remote")
  })
})
