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
  it("BFT finalized chain wins over non-finalized", () => {
    const a = makeCandidate({ bftFinalized: true, height: 5n, peerId: "a" })
    const b = makeCandidate({ bftFinalized: false, height: 10n, peerId: "b" })
    const result = compareForks(a, b)
    assert.equal(result.winner, a)
    assert.equal(result.reason, "bft-finality")
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

  it("equal candidates return equal reason", () => {
    const a = makeCandidate({ peerId: "a" })
    const b = makeCandidate({ peerId: "b" })
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

  it("BFT finality overrides height", () => {
    const a = makeCandidate({ height: 100n, bftFinalized: false, peerId: "a" })
    const b = makeCandidate({ height: 5n, bftFinalized: true, peerId: "b" })
    const best = selectBestFork([a, b])
    assert.equal(best?.peerId, "b")
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

  it("switches to BFT-finalized remote even if shorter", () => {
    const local = makeCandidate({ height: 20n, bftFinalized: false, peerId: "local" })
    const remote = makeCandidate({ height: 5n, bftFinalized: true, peerId: "remote" })
    const result = shouldSwitchFork(local, remote)
    assert.ok(result)
    assert.equal(result.reason, "bft-finality")
  })
})
