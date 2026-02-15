import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  BftRound,
  EquivocationDetector,
  quorumThreshold,
  accumulatedStake,
  hasQuorum,
} from "./bft.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

const validators = [
  { id: "v1", stake: 100n },
  { id: "v2", stake: 100n },
  { id: "v3", stake: 100n },
]

const unequalValidators = [
  { id: "v1", stake: 300n },
  { id: "v2", stake: 100n },
  { id: "v3", stake: 100n },
]

function makeBlock(height: bigint, hash?: Hex): ChainBlock {
  return {
    number: height,
    hash: hash ?? ("0x" + "ab".repeat(32)) as Hex,
    parentHash: ("0x" + "00".repeat(32)) as Hex,
    proposer: "v1",
    timestampMs: Date.now(),
    txs: [],
    finalized: false,
  }
}

describe("quorumThreshold", () => {
  it("calculates 2/3 + 1 for equal stakes", () => {
    // total=300, 2/3*300 = 200, +1 = 201
    const threshold = quorumThreshold(validators)
    assert.equal(threshold, 201n)
  })

  it("calculates for unequal stakes", () => {
    // total=500, 2/3*500 = 333, +1 = 334
    const threshold = quorumThreshold(unequalValidators)
    assert.equal(threshold, 334n)
  })

  it("handles single validator", () => {
    // total=100, 2/3*100 = 66, +1 = 67
    const threshold = quorumThreshold([{ id: "v1", stake: 100n }])
    assert.equal(threshold, 67n)
  })
})

describe("accumulatedStake", () => {
  it("sums stakes of specified voters", () => {
    assert.equal(accumulatedStake(["v1", "v2"], validators), 200n)
  })

  it("ignores unknown voter IDs", () => {
    assert.equal(accumulatedStake(["v1", "unknown"], validators), 100n)
  })

  it("returns 0 for empty voter list", () => {
    assert.equal(accumulatedStake([], validators), 0n)
  })
})

describe("hasQuorum", () => {
  it("requires 2/3+ stake for quorum", () => {
    // 2 of 3 equal validators = 200/300 = 66.7% < 67% threshold (201)
    assert.equal(hasQuorum(["v1", "v2"], validators), false)
    // all 3 validators = 300/300 = 100%
    assert.equal(hasQuorum(["v1", "v2", "v3"], validators), true)
  })

  it("handles unequal stakes", () => {
    // v1 alone has 300/500 = 60%, threshold is 334 -> false
    assert.equal(hasQuorum(["v1"], unequalValidators), false)
    // v1+v2 = 400/500 = 80% >= 334 -> true
    assert.equal(hasQuorum(["v1", "v2"], unequalValidators), true)
  })
})

describe("BftRound", () => {
  it("starts in propose phase", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })
    assert.equal(round.state.phase, "propose")
    assert.equal(round.state.height, 1n)
  })

  it("transitions propose -> prepare on valid block", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })
    const block = makeBlock(1n)
    const msgs = round.handlePropose(block, "v1")

    assert.equal(round.state.phase, "prepare")
    assert.equal(round.state.proposedBlock, block)
    // Local validator should emit a prepare message
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, "prepare")
    assert.equal(msgs[0].senderId, "v1")
  })

  it("rejects propose with wrong height", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })
    const block = makeBlock(2n)
    const msgs = round.handlePropose(block, "v1")

    assert.equal(round.state.phase, "propose") // unchanged
    assert.equal(msgs.length, 0)
  })

  it("transitions prepare -> commit on quorum", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })

    const block = makeBlock(1n)
    round.handlePropose(block, "v1") // -> prepare, v1 auto-votes

    // v2 prepares
    const msgs2 = round.handlePrepare("v2", block.hash)
    assert.equal(round.state.phase, "prepare") // 2/3 not reached yet (200 < 201)
    assert.equal(msgs2.length, 0)

    // v3 prepares -> quorum reached
    const msgs3 = round.handlePrepare("v3", block.hash)
    assert.equal(round.state.phase, "commit")
    // v1 sends commit vote
    assert.equal(msgs3.length, 1)
    assert.equal(msgs3[0].type, "commit")
  })

  it("transitions commit -> finalized on quorum", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })

    const block = makeBlock(1n)
    round.handlePropose(block, "v1")
    round.handlePrepare("v2", block.hash)
    round.handlePrepare("v3", block.hash) // -> commit, v1 auto-commits

    // v2 commits
    const f2 = round.handleCommit("v2", block.hash)
    assert.equal(f2, false) // 200 < 201

    // v3 commits -> finalized
    const f3 = round.handleCommit("v3", block.hash)
    assert.equal(f3, true)
    assert.equal(round.state.phase, "finalized")
  })

  it("rejects prepare from unknown validator", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })
    const block = makeBlock(1n)
    round.handlePropose(block, "v1")
    round.handlePrepare("unknown", block.hash)
    assert.equal(round.state.prepareVotes.size, 1) // only v1
  })

  it("rejects prepare vote for wrong block hash", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })
    const block = makeBlock(1n)
    round.handlePropose(block, "v1")
    round.handlePrepare("v2", ("0x" + "ff".repeat(32)) as Hex)
    assert.equal(round.state.prepareVotes.size, 1) // only v1
  })

  it("handles unequal stake quorum correctly", () => {
    const round = new BftRound(1n, {
      validators: unequalValidators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })

    const block = makeBlock(1n)
    round.handlePropose(block, "v1") // v1 auto-prepares (300)

    // v1(300) + v2(100) = 400 >= 334 -> quorum
    round.handlePrepare("v2", block.hash)
    assert.equal(round.state.phase, "commit")
  })

  it("non-validator does not emit messages", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "observer",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })

    const block = makeBlock(1n)
    const msgs = round.handlePropose(block, "v1")
    assert.equal(msgs.length, 0)
  })

  it("detects timeout", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 1, // 1ms timeout
      commitTimeoutMs: 1,
    })

    const block = makeBlock(1n)
    round.handlePropose(block, "v1")
    // Force time to be past start
    round.state.startedAtMs = Date.now() - 10
    assert.equal(round.isTimedOut(), true)
  })

  it("fail() sets phase to failed", () => {
    const round = new BftRound(1n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })
    round.fail()
    assert.equal(round.state.phase, "failed")
  })

  it("full 3-phase commit flow", () => {
    // Simulate a complete BFT round with all 3 validators
    const round = new BftRound(5n, {
      validators,
      localId: "v1",
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
    })

    const block = makeBlock(5n)

    // Phase 1: Propose
    const prepareMsg = round.handlePropose(block, "v1")
    assert.equal(round.state.phase, "prepare")
    assert.equal(prepareMsg.length, 1)

    // Phase 2: Prepare votes from all validators
    round.handlePrepare("v2", block.hash)
    const commitMsgs = round.handlePrepare("v3", block.hash)
    assert.equal(round.state.phase, "commit")
    assert.equal(commitMsgs.length, 1) // v1 auto-commits

    // Phase 3: Commit votes from all validators
    round.handleCommit("v2", block.hash)
    const finalized = round.handleCommit("v3", block.hash)
    assert.equal(finalized, true)
    assert.equal(round.state.phase, "finalized")
  })
})

describe("EquivocationDetector", () => {
  const hash1 = ("0x" + "aa".repeat(32)) as Hex
  const hash2 = ("0x" + "bb".repeat(32)) as Hex

  it("returns null for first vote", () => {
    const d = new EquivocationDetector()
    const ev = d.recordVote("v1", 1n, "prepare", hash1)
    assert.equal(ev, null)
  })

  it("returns null for same hash vote", () => {
    const d = new EquivocationDetector()
    d.recordVote("v1", 1n, "prepare", hash1)
    const ev = d.recordVote("v1", 1n, "prepare", hash1)
    assert.equal(ev, null)
  })

  it("detects equivocation for different hashes", () => {
    const d = new EquivocationDetector()
    d.recordVote("v1", 1n, "prepare", hash1)
    const ev = d.recordVote("v1", 1n, "prepare", hash2)
    assert.ok(ev)
    assert.equal(ev.validatorId, "v1")
    assert.equal(ev.phase, "prepare")
    assert.equal(ev.blockHash1, hash1)
    assert.equal(ev.blockHash2, hash2)
  })

  it("tracks equivocation evidence", () => {
    const d = new EquivocationDetector()
    d.recordVote("v1", 1n, "prepare", hash1)
    d.recordVote("v1", 1n, "prepare", hash2)
    assert.equal(d.getEvidence().length, 1)
    assert.equal(d.getEvidenceFor("v1").length, 1)
    assert.equal(d.getEvidenceFor("v2").length, 0)
  })

  it("does not cross-detect between heights", () => {
    const d = new EquivocationDetector()
    d.recordVote("v1", 1n, "prepare", hash1)
    const ev = d.recordVote("v1", 2n, "prepare", hash2)
    assert.equal(ev, null)
  })

  it("does not cross-detect between phases", () => {
    const d = new EquivocationDetector()
    d.recordVote("v1", 1n, "prepare", hash1)
    const ev = d.recordVote("v1", 1n, "commit", hash2)
    assert.equal(ev, null)
  })

  it("prunes old heights", () => {
    const d = new EquivocationDetector(5)
    for (let i = 0; i < 10; i++) {
      d.recordVote("v1", BigInt(i), "prepare", hash1)
    }
    // After adding height 9, heights 0-4 should be pruned
    const ev = d.recordVote("v1", 0n, "prepare", hash2)
    // Height 0 was pruned, so this is treated as a new vote, not equivocation
    assert.equal(ev, null)
  })

  it("clearEvidenceBefore removes old evidence", () => {
    const d = new EquivocationDetector()
    d.recordVote("v1", 1n, "prepare", hash1)
    d.recordVote("v1", 1n, "prepare", hash2)
    d.recordVote("v2", 5n, "commit", hash1)
    d.recordVote("v2", 5n, "commit", hash2)
    assert.equal(d.getEvidence().length, 2)
    const removed = d.clearEvidenceBefore(3n)
    assert.equal(removed, 1)
    assert.equal(d.getEvidence().length, 1)
  })
})
