/**
 * Tests for runtime/lib/pose-slash-total.ts (Phase I4).
 *
 * Pure-function tests; no contract instance, no RPC. Validates the
 * relayer's slashTotal estimator against the contract's settleChallenge
 * arithmetic for representative cases.
 */

import { test } from "node:test"
import assert from "node:assert"
import {
  expectedSlashAmount,
  computeExpectedSlashTotal,
  SLASH_EPOCH_CAP_BPS,
  BPS_DENOMINATOR,
} from "./pose-slash-total.ts"

test("Phase I4: expectedSlashAmount returns 10% of bond when nothing slashed yet", () => {
  const slash = expectedSlashAmount({
    targetNodeId: "0xnode1",
    bondAmountWei: 1_000_000_000_000_000_000n, // 1 ETH
    alreadySlashedThisEpochWei: 0n,
  })
  // Cap = 10% = 0.1 ETH
  assert.strictEqual(slash, 100_000_000_000_000_000n)
})

test("Phase I4: expectedSlashAmount returns 0 when bond is 0", () => {
  assert.strictEqual(
    expectedSlashAmount({
      targetNodeId: "0xnode1",
      bondAmountWei: 0n,
      alreadySlashedThisEpochWei: 0n,
    }),
    0n,
  )
})

test("Phase I4: expectedSlashAmount caps at remaining 10% bucket when partially slashed", () => {
  // bond = 1 ETH, cap = 0.1 ETH, already slashed = 0.07 ETH this epoch
  // → expected = 0.03 ETH
  const slash = expectedSlashAmount({
    targetNodeId: "0xnode1",
    bondAmountWei: 1_000_000_000_000_000_000n,
    alreadySlashedThisEpochWei: 70_000_000_000_000_000n,
  })
  assert.strictEqual(slash, 30_000_000_000_000_000n)
})

test("Phase I4: expectedSlashAmount returns 0 when cap already exhausted", () => {
  const slash = expectedSlashAmount({
    targetNodeId: "0xnode1",
    bondAmountWei: 1_000_000_000_000_000_000n,
    alreadySlashedThisEpochWei: 100_000_000_000_000_000n, // exactly the cap
  })
  assert.strictEqual(slash, 0n)
})

test("Phase I4: computeExpectedSlashTotal sums distinct nodeIds at full cap each", () => {
  const total = computeExpectedSlashTotal([
    {
      targetNodeId: "0xnodeA",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
    {
      targetNodeId: "0xnodeB",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
  ])
  // Two distinct nodes × 0.1 ETH cap each
  assert.strictEqual(total, 200_000_000_000_000_000n)
})

test("Phase I4: computeExpectedSlashTotal shares cap across same nodeId", () => {
  // Same nodeId in three challenges — total slash for that node still
  // capped at 10% of bond.
  const total = computeExpectedSlashTotal([
    {
      targetNodeId: "0xnodeA",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
    {
      targetNodeId: "0xnodeA",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
    {
      targetNodeId: "0xnodeA",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
  ])
  // First call slashes 0.1, next two see cap exhausted in running map → 0
  assert.strictEqual(total, 100_000_000_000_000_000n)
})

test("Phase I4: computeExpectedSlashTotal handles case-insensitive nodeIds", () => {
  // Same node in different casings should still share the cap.
  const total = computeExpectedSlashTotal([
    {
      targetNodeId: "0xABCDEF",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
    {
      targetNodeId: "0xabcdef",
      bondAmountWei: 1_000_000_000_000_000_000n,
      alreadySlashedThisEpochWei: 0n,
    },
  ])
  assert.strictEqual(total, 100_000_000_000_000_000n)
})

test("Phase I4: computeExpectedSlashTotal accepts custom cap config", () => {
  // Custom 25% cap
  const total = computeExpectedSlashTotal(
    [
      {
        targetNodeId: "0xnodeA",
        bondAmountWei: 1_000_000_000_000_000_000n,
        alreadySlashedThisEpochWei: 0n,
      },
    ],
    { capBps: 2500n },
  )
  assert.strictEqual(total, 250_000_000_000_000_000n)
})

test("Phase I4: empty challenge list yields zero slashTotal", () => {
  assert.strictEqual(computeExpectedSlashTotal([]), 0n)
})

test("Phase I4: constants match contract values", () => {
  // PoSeManagerV2.SLASH_EPOCH_CAP_BPS = 1000 (10%); BPS_DENOMINATOR = 10000
  assert.strictEqual(SLASH_EPOCH_CAP_BPS, 1000n)
  assert.strictEqual(BPS_DENOMINATOR, 10_000n)
})
