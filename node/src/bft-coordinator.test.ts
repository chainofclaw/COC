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
    await coord.handleMessage({
      type: "prepare",
      height: 1n,
      blockHash: block.hash,
      senderId: "v2",
    })

    // v3 sends prepare -> quorum, should transition to commit
    await coord.handleMessage({
      type: "prepare",
      height: 1n,
      blockHash: block.hash,
      senderId: "v3",
    })

    // v1 should have broadcasted commit
    const commitMsgs = broadcasted.filter((m) => m.type === "commit")
    assert.equal(commitMsgs.length, 1)

    // v2 commits
    await coord.handleMessage({
      type: "commit",
      height: 1n,
      blockHash: block.hash,
      senderId: "v2",
    })

    // v3 commits -> finalized
    await coord.handleMessage({
      type: "commit",
      height: 1n,
      blockHash: block.hash,
      senderId: "v3",
    })

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
    await coord.handleMessage({
      type: "prepare",
      height: 3n,
      blockHash: ("0x" + "ff".repeat(32)) as Hex,
      senderId: "v2",
    })

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
    await coord.handleMessage({
      type: "prepare",
      height: 1n,
      blockHash: ("0x" + "ff".repeat(32)) as Hex,
      senderId: "v2",
    })

    assert.equal(coord.getRoundState().active, false)
  })

  it("new round replaces existing round", async () => {
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
    })

    await coord.startRound(makeBlock(1n))
    assert.equal(coord.getRoundState().height, 1n)

    await coord.startRound(makeBlock(2n))
    assert.equal(coord.getRoundState().height, 2n)
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
})
