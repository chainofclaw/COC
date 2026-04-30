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

  it("on prepare-phase timeout with divergent stateRoots, dump diagnostic with all votes + proposed block", async () => {
    // Pins the diagnostic added 2026-04-30 for the recurring testnet
    // pair-quorum stalls. Simulates 3 validators voting for the same
    // blockHash but 3 different stateRoots → no 2/3 quorum on any pair
    // → round times out → diagnostic must surface the full vote table
    // + proposed-block context.
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex
    const v2Root = ("0x" + "bb".repeat(32)) as Hex
    const v3Root = ("0x" + "cc".repeat(32)) as Hex

    // Capture log calls — we can't easily intercept the module-level log
    // without monkey-patching, so we just rely on the diagnostic running
    // without throwing (smoke). The detailed log content is exercised
    // implicitly by the existing "quorum does NOT finalize" test above
    // plus this one's coverage of the dump path.
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 50,
      commitTimeoutMs: 50,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => ourRoot,
    })

    const block = makeBlock(1n)
    await coord.startRound(block)

    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v2"), stateRoot: v2Root })
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v3"), stateRoot: v3Root })

    // Wait past timeout so dumpDivergenceDiagnostics fires from the
    // setTimeout handler. If the dump throws, this test would fail with
    // an unhandled rejection.
    await new Promise((r) => setTimeout(r, 200))

    // After timeout, round should have been cleared. Coordinator must
    // remain usable for the next round (the dump must NOT corrupt state).
    const state = coord.getRoundState()
    assert.equal(state.active, false, "round must be cleared after timeout")
  })

  it("Phase H4: fires onPeerQuorumDiverged when ≥2/3 of OTHER validators converge on a stateRoot we can't reproduce", async () => {
    // Pins the 2026-04-30 testnet stall: relaxedQuorum lets node-2/3
    // finalize on (hash, peerRoot) using their 2-of-3 stake while node-1
    // votes alone with localRoot. Without H4 the lagging node sits silent
    // until the next syncIntervalMs tick (30-60s); the chain has already
    // deadlocked by then because the proposer round-robin returned to it.
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex
    const peerRoot = ("0x" + "bb".repeat(32)) as Hex

    let divergence: { height: bigint; peerBlockHash: Hex; peerStateRoot: Hex; localStateRoot?: Hex } | null = null
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 50,
      commitTimeoutMs: 50,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => ourRoot,
      onPeerQuorumDiverged: (info) => { divergence = info },
    })

    const block = makeBlock(1n)
    await coord.startRound(block)

    // v2 + v3 prepare with a stateRoot v1 (us) can't reproduce. Together
    // they hold 200/300 stake = 2/3 → relaxedQuorum quorum threshold.
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v2"), stateRoot: peerRoot })
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v3"), stateRoot: peerRoot })

    // Wait past timeout so the H4 detection runs.
    await new Promise((r) => setTimeout(r, 200))

    assert.ok(divergence, "onPeerQuorumDiverged must fire")
    assert.equal(divergence!.height, 1n)
    assert.equal(divergence!.peerBlockHash, block.hash)
    assert.equal(divergence!.peerStateRoot, peerRoot)
    assert.equal(divergence!.localStateRoot, ourRoot)
  })

  it("Phase H4: does NOT fire onPeerQuorumDiverged when local matches peer quorum", async () => {
    // When all three nodes agree on the same stateRoot, the round
    // finalizes via early-commits — no divergence to surface. The
    // callback must NOT fire spuriously even if the timeout path hits
    // for an unrelated reason (e.g. commit-phase timeout).
    const agreed = ("0x" + "cc".repeat(32)) as Hex
    let divergenceFiredCount = 0
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 50,
      commitTimeoutMs: 50,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => agreed,
      onPeerQuorumDiverged: () => { divergenceFiredCount++ },
    })

    const block = makeBlock(1n)
    await coord.startRound(block)

    // All three agree — but no commits, so the commit phase will time out.
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v2"), stateRoot: agreed })
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v3"), stateRoot: agreed })

    await new Promise((r) => setTimeout(r, 200))

    assert.equal(divergenceFiredCount, 0, "no peer divergence to report when local matches quorum")
  })

  it("Phase H5: fires onPersistentDivergence after N consecutive divergences", async () => {
    // After 3 consecutive prepare-phase timeouts where peers reached 2/3
    // quorum on a stateRoot we couldn't reproduce, the persistent-
    // divergence callback fires. This is the testnet "leveldb is
    // corrupted at-rest, incremental sync loops forever" path — we
    // escalate to a full state-snapshot import.
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex
    const peerRoot = ("0x" + "bb".repeat(32)) as Hex

    const persistentEvents: Array<{ height: bigint; consecutiveCount: number }> = []
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 30,
      commitTimeoutMs: 30,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => ourRoot,
      persistentDivergenceThreshold: 3,
      onPersistentDivergence: (info) => persistentEvents.push({
        height: info.height,
        consecutiveCount: info.consecutiveCount,
      }),
    })

    // Drive 3 divergent rounds back-to-back. Each uses a fresh height
    // because the coordinator advances height after each round.
    for (let height = 1n; height <= 3n; height++) {
      await coord.startRound(makeBlock(height))
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v2"), stateRoot: peerRoot })
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v3"), stateRoot: peerRoot })
      await new Promise((r) => setTimeout(r, 100))
    }

    assert.equal(persistentEvents.length, 1, "fires once when threshold crossed")
    assert.equal(persistentEvents[0].height, 3n)
    assert.equal(persistentEvents[0].consecutiveCount, 3)
  })

  it("Phase H5: does NOT fire below threshold (only 2 consecutive divergences)", async () => {
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex
    const peerRoot = ("0x" + "bb".repeat(32)) as Hex

    let persistentFired = 0
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 30,
      commitTimeoutMs: 30,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => ourRoot,
      persistentDivergenceThreshold: 3,
      onPersistentDivergence: () => persistentFired++,
    })

    for (let height = 1n; height <= 2n; height++) {
      await coord.startRound(makeBlock(height))
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v2"), stateRoot: peerRoot })
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v3"), stateRoot: peerRoot })
      await new Promise((r) => setTimeout(r, 100))
    }

    assert.equal(persistentFired, 0, "below threshold — must not escalate")
  })

  it("Phase H5: counter resets on successful finalize — transient divergence doesn't escalate", async () => {
    // Divergence × 2, then a clean finalize, then 2 more divergences.
    // Counter should reset after the clean finalize so the second pair
    // doesn't escalate (5 cumulative ≠ 3 consecutive).
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex
    const peerRoot = ("0x" + "bb".repeat(32)) as Hex

    let persistentFired = 0
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 30,
      commitTimeoutMs: 30,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => ourRoot,
      persistentDivergenceThreshold: 3,
      onPersistentDivergence: () => persistentFired++,
    })

    // Two divergent rounds.
    for (let height = 1n; height <= 2n; height++) {
      await coord.startRound(makeBlock(height))
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v2"), stateRoot: peerRoot })
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v3"), stateRoot: peerRoot })
      await new Promise((r) => setTimeout(r, 100))
    }
    // Successful finalize — all 3 agree on ourRoot.
    const block3 = makeBlock(3n)
    await coord.startRound(block3)
    await coord.handleMessage({ ...bftMsg("prepare", 3n, block3.hash, "v2"), stateRoot: ourRoot })
    await coord.handleMessage({ ...bftMsg("prepare", 3n, block3.hash, "v3"), stateRoot: ourRoot })
    // The early-commits path needs commits too — send them so the finalize
    // path runs and the counter resets.
    await coord.handleMessage({ ...bftMsg("commit", 3n, block3.hash, "v2"), stateRoot: ourRoot })
    await coord.handleMessage({ ...bftMsg("commit", 3n, block3.hash, "v3"), stateRoot: ourRoot })

    // Two more divergent rounds.
    for (let height = 4n; height <= 5n; height++) {
      await coord.startRound(makeBlock(height))
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v2"), stateRoot: peerRoot })
      await coord.handleMessage({ ...bftMsg("prepare", height, makeBlock(height).hash, "v3"), stateRoot: peerRoot })
      await new Promise((r) => setTimeout(r, 100))
    }

    assert.equal(persistentFired, 0, "reset after finalize — only 2 consecutive divergences post-reset")
  })

  it("Phase H4: does NOT fire when only 1 of 2 other validators votes — peer quorum not reached", async () => {
    // 1/3 stake from v2 with a different root is NOT 2/3 quorum, so peers
    // CAN'T finalize without us. We're not "lagging behind" yet — the
    // round just timed out for normal reasons (e.g. unresponsive v3).
    // Triggering catch-up here would cause a sync storm whenever a
    // single validator is offline.
    const ourRoot = ("0x" + "aa".repeat(32)) as Hex
    const v2Root = ("0x" + "bb".repeat(32)) as Hex

    let divergenceFiredCount = 0
    const coord = new BftCoordinator({
      localId: "v1",
      validators,
      prepareTimeoutMs: 50,
      commitTimeoutMs: 50,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
      computeLocalStateRoot: async () => ourRoot,
      onPeerQuorumDiverged: () => { divergenceFiredCount++ },
    })

    const block = makeBlock(1n)
    await coord.startRound(block)

    // Only v2 votes — v3 is silent. peer pair (hash, v2Root) has only
    // 100/300 = 1/3 stake. Below 2/3 threshold.
    await coord.handleMessage({ ...bftMsg("prepare", 1n, block.hash, "v2"), stateRoot: v2Root })

    await new Promise((r) => setTimeout(r, 200))

    assert.equal(divergenceFiredCount, 0, "single peer with different root is below 2/3 quorum")
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
