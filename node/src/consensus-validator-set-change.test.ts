import test from "node:test"
import assert from "node:assert/strict"
import { ConsensusEngine } from "./consensus.ts"
import { BftCoordinator } from "./bft-coordinator.ts"
import type { BftMessage } from "./bft.ts"
import type { ChainBlock } from "./blockchain-types.ts"

/**
 * PR-1B: lastProposed cache + BFT local state must be invalidated when the
 * validator set membership changes (ValidatorRegistry reader detects an
 * add/remove between polls).
 *
 * 2026-05-09 attempt #1 fingerprint: reader-driven set switch from N=3 to N=8
 * silently kept consensus.lastProposedBlock pointing at a block whose proposer
 * was assigned by the OLD rotation. Re-broadcast on round timeout replayed the
 * stale block, peers' Phase R refused self-equivocation, chain stalled 7 hours.
 *
 * Fix: BftCoordinator.updateValidators detects membership change and clears
 * localPreparedAt / localCommittedAt / localPreparedBlock / pendingMessages
 * (and force-clears any active round). ConsensusEngine.clearLastProposed()
 * resets the lastProposedHeight/Block fields.  index.ts wires the reader's
 * applyActiveSet callback to call both.
 */

const VALIDATORS_3 = [
  { id: "node-1", stake: 32n },
  { id: "node-2", stake: 32n },
  { id: "node-3", stake: 32n },
]
const VALIDATORS_5 = [
  ...VALIDATORS_3,
  { id: "node-4", stake: 32n },
  { id: "node-5", stake: 32n },
]
const VALIDATORS_3_RESTAKED = [
  { id: "node-1", stake: 64n },
  { id: "node-2", stake: 32n },
  { id: "node-3", stake: 32n },
]

function mkBft(): BftCoordinator {
  return new BftCoordinator({
    localId: "node-1",
    validators: [...VALIDATORS_3],
    broadcastMessage: async () => {},
    onFinalized: async () => {},
  })
}

const mkMockChain = (validators: Array<{ id: string; stake: bigint }>): any => ({
  getHeight: async () => 0n,
  getTip: async () => null,
  expectedProposer: (h: bigint) =>
    validators[Number((h - 1n) % BigInt(validators.length))].id,
  mempool: { getPendingTxs: () => [] },
  events: { on: () => {}, off: () => {} },
})

const mkMockP2p = (): any => ({
  fetchSnapshots: async () => [],
  receiveBlock: async () => {},
})

test("PR-1B: BftCoordinator.updateValidators clears local state on membership add", () => {
  const bft = mkBft()
  // Seed local state caches as if we'd voted at heights 5/6/7
  ;(bft as any).localPreparedAt.set(5n, "0xaa")
  ;(bft as any).localCommittedAt.set(5n, "0xaa")
  ;(bft as any).localPreparedBlock.set(5n, { number: 5n, hash: "0xaa" } as ChainBlock)
  ;(bft as any).pendingMessages.push({
    type: "prepare",
    height: 6n,
    blockHash: "0xbb",
    senderId: "node-2",
  } as BftMessage)

  // Add 2 new validators: membership changed
  bft.updateValidators(VALIDATORS_5)

  assert.equal((bft as any).localPreparedAt.size, 0, "localPreparedAt cleared")
  assert.equal((bft as any).localCommittedAt.size, 0, "localCommittedAt cleared")
  assert.equal((bft as any).localPreparedBlock.size, 0, "localPreparedBlock cleared")
  assert.equal((bft as any).pendingMessages.length, 0, "pendingMessages cleared")
})

test("PR-1B: BftCoordinator.updateValidators clears local state on membership remove", () => {
  const bft = new BftCoordinator({
    localId: "node-1",
    validators: [...VALIDATORS_5],
    broadcastMessage: async () => {},
    onFinalized: async () => {},
  })

  ;(bft as any).localPreparedAt.set(10n, "0xab")
  ;(bft as any).pendingMessages.push({
    type: "commit",
    height: 11n,
    blockHash: "0xcd",
    senderId: "node-5",
  } as BftMessage)

  // Remove 2 validators
  bft.updateValidators(VALIDATORS_3)

  assert.equal((bft as any).localPreparedAt.size, 0)
  assert.equal((bft as any).pendingMessages.length, 0)
})

test("PR-1B: BftCoordinator.updateValidators preserves caches on stake-only change", () => {
  // Stake update without membership change is a regular governance event;
  // running BFT rounds must continue undisturbed.
  const bft = mkBft()
  ;(bft as any).localPreparedAt.set(5n, "0xaa")
  ;(bft as any).localPreparedBlock.set(5n, { number: 5n, hash: "0xaa" } as ChainBlock)
  ;(bft as any).pendingMessages.push({
    type: "prepare",
    height: 6n,
    blockHash: "0xbb",
    senderId: "node-2",
  } as BftMessage)

  bft.updateValidators(VALIDATORS_3_RESTAKED)

  assert.equal((bft as any).localPreparedAt.size, 1, "preserve on stake-only change")
  assert.equal((bft as any).localPreparedBlock.size, 1)
  assert.equal((bft as any).pendingMessages.length, 1)
  // Stakes were updated though
  assert.equal((bft as any).cfg.validators[0].stake, 64n)
})

test("PR-1B: BftCoordinator.updateValidators is case-insensitive for membership comparison", () => {
  // Reader returns lowercase, hardcoded config may be EIP-55 mixed-case.
  // Treat them as the same set so casing churn doesn't trigger spurious clears.
  const bft = new BftCoordinator({
    localId: "node-1",
    validators: [
      { id: "0xAaBb", stake: 32n },
      { id: "0xCcDd", stake: 32n },
    ],
    broadcastMessage: async () => {},
    onFinalized: async () => {},
  })
  ;(bft as any).localPreparedAt.set(5n, "0xff")

  bft.updateValidators([
    { id: "0xaabb", stake: 32n },
    { id: "0xccdd", stake: 32n },
  ])

  assert.equal((bft as any).localPreparedAt.size, 1, "case difference is not membership change")
})

test("PR-1B: ConsensusEngine.clearLastProposed resets cached block + height", () => {
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_3),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { nodeId: "node-1" },
  )
  ;(c as any).lastProposedHeight = 17n
  ;(c as any).lastProposedBlock = { number: 17n, hash: "0xab" }

  c.clearLastProposed()

  assert.equal((c as any).lastProposedHeight, undefined)
  assert.equal((c as any).lastProposedBlock, undefined)
})

test("PR-1B: ConsensusEngine.onValidatorSetChange clears caches AND calls bft.updateValidators", () => {
  const bft = mkBft()
  const c = new ConsensusEngine(
    mkMockChain(VALIDATORS_5),
    mkMockP2p(),
    { blockTimeMs: 1000, syncIntervalMs: 300_000 },
    { bft, nodeId: "node-1" },
  )
  ;(c as any).lastProposedHeight = 5n
  ;(c as any).lastProposedBlock = { number: 5n, hash: "0xff" }
  ;(bft as any).localPreparedAt.set(5n, "0xff")

  c.onValidatorSetChange(VALIDATORS_5)

  assert.equal((c as any).lastProposedHeight, undefined, "lastProposed cleared")
  assert.equal((c as any).lastProposedBlock, undefined)
  assert.equal((bft as any).localPreparedAt.size, 0, "BFT local state cleared")
  assert.equal((bft as any).cfg.validators.length, 5, "BFT validators updated")
})

test("PR-1B: BftCoordinator.updateValidators force-clears active round on membership change", async () => {
  // If we hold an active round during a membership change, the round was
  // started under stake-snapshot from the OLD set. Continuing under it
  // would compute quorum against stale stake distribution and could leave
  // votes unfulfilled. Cleaner to drop and let the next propose start fresh.
  const bft = mkBft()
  // Inject a fake active round
  ;(bft as any).activeRound = {
    state: { height: 5n, phase: "prepare", prepareVotes: new Map(), commitVotes: new Map() },
  }
  // Trigger membership change
  bft.updateValidators(VALIDATORS_5)

  assert.equal((bft as any).activeRound, null, "active round cleared on membership change")
})
