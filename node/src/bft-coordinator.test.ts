import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { BftCoordinator } from "./bft-coordinator.ts"
import type { BftMessage } from "./bft.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

const validators = [
  { id: "v1", stake: 100n },
  { id: "v2", stake: 100n },
  { id: "v3", stake: 100n },
]

const DUMMY_SIG = ("0x" + "de".repeat(65)) as Hex

function makeBlock(height: bigint, proposer = "v1"): ChainBlock {
  return {
    number: height,
    hash: ("0x" + "ab".repeat(32)) as Hex,
    parentHash: ("0x" + "00".repeat(32)) as Hex,
    proposer,
    timestampMs: Date.now(),
    txs: [],
    finalized: false,
  }
}

function bftMsg(type: "prepare" | "commit", height: bigint, blockHash: Hex, senderId: string): BftMessage {
  return { type, height, blockHash, senderId, signature: DUMMY_SIG }
}

describe("BftCoordinator", () => {
  it("starts a round and broadcasts prepare", async () => {
    const broadcasted: BftMessage[] = []

    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async (msg) => { broadcasted.push(msg) },
      onFinalized: async () => {},
    })

    const block = makeBlock(1n, "v1")
    await coord.startRound(block)

    // v1 should have broadcasted a prepare message
    assert.equal(broadcasted.length, 1)
    assert.equal(broadcasted[0].type, "prepare")
    assert.equal(broadcasted[0].senderId, "v1")

    const state = coord.getRoundState()
    assert.equal(state.active, true)
    assert.equal(state.height, 1n)
    assert.equal(state.phase, "prepare")
  })

  it("transitions through full BFT lifecycle", async () => {
    const broadcasted: BftMessage[] = []
    let finalizedBlock: ChainBlock | null = null

    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async (msg) => { broadcasted.push(msg) },
      onFinalized: async (block) => { finalizedBlock = block },
    })

    const block = makeBlock(1n, "v1")
    await coord.startRound(block)
    assert.equal(broadcasted.length, 1) // prepare from v1

    // v2 sends prepare
    await coord.handleMessage(bftMsg("prepare", 1n, block.hash, "v2"))

    // v3 sends prepare -> quorum, should transition to commit
    await coord.handleMessage(bftMsg("prepare", 1n, block.hash, "v3"))

    // v1 should have broadcasted commit
    const commitMsgs = broadcasted.filter((m) => m.type === "commit")
    assert.equal(commitMsgs.length, 1)

    // v2 commits
    await coord.handleMessage(bftMsg("commit", 1n, block.hash, "v2"))

    // v3 commits -> finalized
    await coord.handleMessage(bftMsg("commit", 1n, block.hash, "v3"))

    assert.ok(finalizedBlock)
    assert.equal(finalizedBlock.number, 1n)

    // Round should be cleared
    const state = coord.getRoundState()
    assert.equal(state.active, false)
  })

  it("ignores messages for wrong height", async () => {
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
    })

    await coord.startRound(makeBlock(5n))

    // Message for height 3 should be ignored
    await coord.handleMessage(bftMsg("prepare", 3n, ("0x" + "ff".repeat(32)) as Hex, "v2"))

    const state = coord.getRoundState()
    assert.equal(state.prepareVotes, 1) // only v1's own vote
  })

  it("ignores messages when no active round", async () => {
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
    })

    // Should not throw
    await coord.handleMessage(bftMsg("prepare", 1n, ("0x" + "ff".repeat(32)) as Hex, "v2"))

    assert.equal(coord.getRoundState().active, false)
  })

  it("new round defers if active round has progress", async () => {
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
    })

    await coord.startRound(makeBlock(1n))
    assert.equal(coord.getRoundState().height, 1n)

    // Second startRound is deferred because round 1 has votes (local prepare)
    await coord.startRound(makeBlock(2n))
    assert.equal(coord.getRoundState().height, 1n) // Still at height 1
  })

  it("updateValidators changes the set", async () => {
    const coord = new BftCoordinator({
      localId: "v1",
      validators: [{ id: "v1", stake: 100n }],
      broadcastMessage: async () => {},
      onFinalized: async () => {},
    })

    coord.updateValidators(validators)
    // Next round will use updated validators
    await coord.startRound(makeBlock(1n))
    assert.equal(coord.getRoundState().active, true)
  })

  it("non-validator coordinator observes but does not vote", async () => {
    const broadcasted: BftMessage[] = []

    const coord = new BftCoordinator({
      localId: "observer",
      validators,
      broadcastMessage: async (msg) => { broadcasted.push(msg) },
      onFinalized: async () => {},
    })

    await coord.startRound(makeBlock(1n))
    assert.equal(broadcasted.length, 0) // observer doesn't vote
  })

  // --- Phase B integration: computeLocalStateRoot wired through to prepare vote.
  // See plans/coc-phase-b-stateroot-vote.md §B2.7. Covers the end-to-end BFT
  // contract that (a) prepare votes carry the stateRoot from the hook, and
  // (b) validators whose hook returns a different value form a separate
  // quorum group — the (blockHash, stateRoot) pair fails to reach 2/3 when
  // a proposer claims a stateRoot we can't reproduce.

  it("computeLocalStateRoot output is attached to the outgoing prepare vote", async () => {
    const broadcasted: BftMessage[] = []
    const fakeRoot = ("0x" + "be".repeat(32)) as Hex
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async (msg) => { broadcasted.push(msg) },
      onFinalized: async () => {},
      computeLocalStateRoot: async () => fakeRoot,
    })

    await coord.startRound(makeBlock(1n))
    const prep = broadcasted.find((m) => m.type === "prepare")
    assert.ok(prep, "prepare vote must be broadcast")
    assert.strictEqual(prep!.stateRoot, fakeRoot, "prepare carries the stateRoot the hook returned")
  })

  it("quorum does NOT finalize when proposer's claimed stateRoot diverges from our hook", async () => {
    let finalized = false
    const broadcasted: BftMessage[] = []
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex   // what we (v1) compute
    const theirRoot = ("0x" + "bb".repeat(32)) as Hex // what v2/v3 (on a fork) compute

    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 100, // short so the test doesn't hang
      commitTimeoutMs: 100,
      broadcastMessage: async (msg) => { broadcasted.push(msg) },
      onFinalized: async () => { finalized = true },
      computeLocalStateRoot: async () => ourRoot,
    })

    const block = makeBlock(1n)
    await coord.startRound(block)

    // v2 and v3 vote with a different stateRoot — their speculative would
    // have computed a different post-state (simulating a proposer whose
    // claimed block can't be reproduced by 2/3 of the set).
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v2"), stateRoot: theirRoot })
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v3"), stateRoot: theirRoot })

    // Wait past the prepare timeout so the coordinator clears the round.
    await new Promise((r) => setTimeout(r, 200))

    assert.equal(finalized, false, "quorum on (blockHash, ourRoot) must NOT form — our vote is alone")
    const commit = broadcasted.find((m) => m.type === "commit")
    assert.equal(commit, undefined, "no commit should be emitted without prepare quorum")
  })

  it("quorum DOES finalize when all three validators' hooks agree on the stateRoot", async () => {
    let finalized = false
    const broadcasted: BftMessage[] = []
    const agreedRoot = ("0x" + "cc".repeat(32)) as Hex

    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 1000,
      commitTimeoutMs: 1000,
      broadcastMessage: async (msg) => { broadcasted.push(msg) },
      onFinalized: async () => { finalized = true },
      computeLocalStateRoot: async () => agreedRoot,
    })

    const block = makeBlock(1n)
    await coord.startRound(block)

    // v2 and v3 vote the SAME stateRoot — prepare quorum forms.
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v2"), stateRoot: agreedRoot })
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v3"), stateRoot: agreedRoot })
    // Commit quorum.
    await coord.handleMessage({ ...bftMsg("commit", 1n, block.hash, "v2"), stateRoot: agreedRoot })
    await coord.handleMessage({ ...bftMsg("commit", 1n, block.hash, "v3"), stateRoot: agreedRoot })

    assert.equal(finalized, true, "quorum on matching (blockHash, stateRoot) must finalize")
  })
})
