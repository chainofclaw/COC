/**
 * Tests for dispute automation: DisputeMonitor, PenaltyTracker, DisputeLogger
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { DisputeMonitor } from "./dispute-monitor.ts"
import type { BatchInfo, ReceiptLeaf } from "./dispute-monitor.ts"
import { PenaltyTracker } from "./penalty-tracker.ts"
import { DisputeLogger } from "./dispute-logger.ts"
import { EvidenceReason } from "../verifier/anti-cheat-policy.ts"
import type { Hex32 } from "../common/pose-types.ts"

const NODE_A = "0x000000000000000000000000000000000000000000000000000000000000000a" as Hex32
const NODE_B = "0x000000000000000000000000000000000000000000000000000000000000000b" as Hex32
const BATCH_1 = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex32
const BATCH_2 = "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex32

describe("DisputeMonitor", () => {
  let monitor: DisputeMonitor

  beforeEach(() => {
    monitor = new DisputeMonitor()
  })

  it("validates batch with no local receipts", () => {
    const batch: BatchInfo = {
      batchId: BATCH_1,
      epochId: 1n,
      merkleRoot: "0x" + "ab".repeat(32) as Hex32,
      summaryHash: "0x" + "cd".repeat(32) as Hex32,
      aggregator: "0x1234",
      disputeDeadlineEpoch: 10n,
      finalized: false,
      disputed: false,
    }
    const results = monitor.validateBatch(batch)
    assert.ok(results.length > 0)
    assert.ok(results[0].reason.includes("no local receipts"))
  })

  it("skips finalized batches", () => {
    const batch: BatchInfo = {
      batchId: BATCH_1,
      epochId: 1n,
      merkleRoot: "0x" + "ab".repeat(32) as Hex32,
      summaryHash: "0x" + "cd".repeat(32) as Hex32,
      aggregator: "0x1234",
      disputeDeadlineEpoch: 10n,
      finalized: true,
      disputed: false,
    }
    const results = monitor.validateBatch(batch)
    assert.equal(results.length, 0)
  })

  it("skips already disputed batches", () => {
    const batch: BatchInfo = {
      batchId: BATCH_1,
      epochId: 1n,
      merkleRoot: "0x" + "ab".repeat(32) as Hex32,
      summaryHash: "0x" + "cd".repeat(32) as Hex32,
      aggregator: "0x1234",
      disputeDeadlineEpoch: 10n,
      finalized: false,
      disputed: true,
    }
    const results = monitor.validateBatch(batch)
    assert.equal(results.length, 0)
  })

  it("does not re-process same batch", () => {
    const batch: BatchInfo = {
      batchId: BATCH_1,
      epochId: 1n,
      merkleRoot: "0x" + "ab".repeat(32) as Hex32,
      summaryHash: "0x" + "cd".repeat(32) as Hex32,
      aggregator: "0x1234",
      disputeDeadlineEpoch: 10n,
      finalized: false,
      disputed: false,
    }
    monitor.validateBatch(batch)
    const results2 = monitor.validateBatch(batch)
    assert.equal(results2.length, 0)
  })

  it("detects summary hash mismatch", () => {
    const receipts: ReceiptLeaf[] = [
      { challengeId: "0x01" as Hex32, nodeId: NODE_A, responseBodyHash: "0x02" as Hex32 },
    ]
    monitor.addLocalReceipts(1n, receipts)

    const batch: BatchInfo = {
      batchId: BATCH_2,
      epochId: 1n,
      merkleRoot: "0x" + "ab".repeat(32) as Hex32,
      summaryHash: "0x" + "ff".repeat(32) as Hex32,
      aggregator: "0x1234",
      disputeDeadlineEpoch: 10n,
      finalized: false,
      disputed: false,
    }
    const results = monitor.validateBatch(batch)
    assert.ok(results.some((r) => r.reason.includes("summary hash mismatch")))
  })

  it("validates multiple batches", () => {
    const batches: BatchInfo[] = [
      {
        batchId: BATCH_1, epochId: 1n,
        merkleRoot: "0x" + "ab".repeat(32) as Hex32,
        summaryHash: "0x" + "cd".repeat(32) as Hex32,
        aggregator: "0x1234", disputeDeadlineEpoch: 10n,
        finalized: false, disputed: false,
      },
      {
        batchId: BATCH_2, epochId: 2n,
        merkleRoot: "0x" + "ab".repeat(32) as Hex32,
        summaryHash: "0x" + "cd".repeat(32) as Hex32,
        aggregator: "0x1234", disputeDeadlineEpoch: 10n,
        finalized: false, disputed: false,
      },
    ]
    const results = monitor.validateBatches(batches)
    assert.ok(results.length >= 2)
  })

  it("reports correct stats", () => {
    monitor.addLocalReceipts(1n, [])
    const stats = monitor.stats()
    assert.equal(stats.epochsTracked, 1)
    assert.equal(stats.batchesProcessed, 0)
  })
})

describe("PenaltyTracker", () => {
  let tracker: PenaltyTracker

  beforeEach(() => {
    tracker = new PenaltyTracker({ suspendThreshold: 30, ejectThreshold: 80 })
  })

  it("records penalty and accumulates points", () => {
    tracker.recordPenalty(NODE_A, EvidenceReason.Timeout, 1n)
    const state = tracker.getState(NODE_A)
    assert.ok(state)
    assert.equal(state!.totalPoints, 5) // Timeout = 5 points
    assert.equal(state!.records.length, 1)
  })

  it("suspends node at threshold", () => {
    // Timeout (5) x6 = 30, hits threshold
    for (let i = 0; i < 6; i++) {
      tracker.recordPenalty(NODE_A, EvidenceReason.Timeout, BigInt(i))
    }
    assert.ok(tracker.isPenalized(NODE_A))
    const state = tracker.getState(NODE_A)
    assert.ok(state!.suspended)
  })

  it("ejects node at eject threshold", () => {
    // StorageProofInvalid (30) x3 = 90, above eject threshold (80)
    for (let i = 0; i < 3; i++) {
      tracker.recordPenalty(NODE_A, EvidenceReason.StorageProofInvalid, BigInt(i))
    }
    assert.ok(tracker.isEjected(NODE_A))
    assert.ok(tracker.isPenalized(NODE_A))
  })

  it("tracks multiple nodes independently", () => {
    tracker.recordPenalty(NODE_A, EvidenceReason.Timeout, 1n)
    tracker.recordPenalty(NODE_B, EvidenceReason.ReplayNonce, 1n)

    const stateA = tracker.getState(NODE_A)
    const stateB = tracker.getState(NODE_B)
    assert.equal(stateA!.totalPoints, 5)
    assert.equal(stateB!.totalPoints, 20)
  })

  it("returns penalized nodes list", () => {
    for (let i = 0; i < 6; i++) {
      tracker.recordPenalty(NODE_A, EvidenceReason.Timeout, BigInt(i))
    }
    const penalized = tracker.getPenalizedNodes()
    assert.equal(penalized.length, 1)
    assert.equal(penalized[0].nodeId, NODE_A)
  })

  it("reports stats correctly", () => {
    tracker.recordPenalty(NODE_A, EvidenceReason.Timeout, 1n)
    tracker.recordPenalty(NODE_B, EvidenceReason.Timeout, 1n)
    const stats = tracker.stats()
    assert.equal(stats.tracked, 2)
    assert.equal(stats.suspended, 0)
    assert.equal(stats.ejected, 0)
  })

  it("ignores penalties for ejected nodes", () => {
    // Eject node A
    for (let i = 0; i < 3; i++) {
      tracker.recordPenalty(NODE_A, EvidenceReason.StorageProofInvalid, BigInt(i))
    }
    assert.ok(tracker.isEjected(NODE_A))
    const before = tracker.getState(NODE_A)!.totalPoints

    // Further penalty should not change points
    tracker.recordPenalty(NODE_A, EvidenceReason.Timeout, 10n)
    const after = tracker.getState(NODE_A)!.totalPoints
    assert.equal(before, after)
  })
})

describe("DisputeLogger", () => {
  let logger: DisputeLogger

  beforeEach(() => {
    logger = new DisputeLogger(100)
  })

  it("logs events with auto-incrementing id", () => {
    const e1 = logger.log("challenge_issued", 1n, { target: NODE_A })
    const e2 = logger.log("receipt_verified", 1n, { ok: true })
    assert.equal(e1.id, 1)
    assert.equal(e2.id, 2)
    assert.equal(logger.size, 2)
  })

  it("queries by type", () => {
    logger.log("challenge_issued", 1n, {})
    logger.log("slash_submitted", 1n, {}, { nodeId: NODE_A })
    logger.log("challenge_issued", 2n, {})

    const challenges = logger.query({ type: "challenge_issued" })
    assert.equal(challenges.length, 2)
  })

  it("queries by nodeId", () => {
    logger.log("challenge_issued", 1n, {}, { nodeId: NODE_A })
    logger.log("slash_submitted", 1n, {}, { nodeId: NODE_B })
    logger.log("evidence_created", 2n, {}, { nodeId: NODE_A })

    const nodeAEvents = logger.query({ nodeId: NODE_A })
    assert.equal(nodeAEvents.length, 2)
  })

  it("queries by epochId", () => {
    logger.log("challenge_issued", 1n, {})
    logger.log("challenge_issued", 2n, {})
    logger.log("challenge_issued", 1n, {})

    const epoch1 = logger.query({ epochId: 1n })
    assert.equal(epoch1.length, 2)
  })

  it("limits query results", () => {
    for (let i = 0; i < 10; i++) {
      logger.log("challenge_issued", BigInt(i), {})
    }
    const limited = logger.query({ limit: 3 })
    assert.equal(limited.length, 3)
  })

  it("returns summary counts", () => {
    logger.log("challenge_issued", 1n, {})
    logger.log("challenge_issued", 2n, {})
    logger.log("slash_submitted", 1n, {})

    const summary = logger.summary()
    assert.equal(summary.challenge_issued, 2)
    assert.equal(summary.slash_submitted, 1)
  })

  it("respects max events limit", () => {
    const smallLogger = new DisputeLogger(5)
    for (let i = 0; i < 10; i++) {
      smallLogger.log("challenge_issued", BigInt(i), {})
    }
    assert.equal(smallLogger.size, 5)
  })

  it("gets node history", () => {
    logger.log("challenge_issued", 1n, {}, { nodeId: NODE_A })
    logger.log("receipt_failed", 1n, { reason: "timeout" }, { nodeId: NODE_A })

    const history = logger.getNodeHistory(NODE_A)
    assert.equal(history.length, 2)
  })
})
