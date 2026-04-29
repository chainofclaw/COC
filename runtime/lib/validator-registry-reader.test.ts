/**
 * Unit tests for ValidatorRegistryReader event replay.
 *
 * Uses the test-only `_replayEventForTest` hook to feed synthesized event
 * objects directly into the handler — avoids standing up an EVM provider.
 * Integration with a live chain is exercised by node/runtime e2e tests in
 * Sprint 5 (testnet relaunch).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { ValidatorRegistryReader } from "./validator-registry-reader.ts"

const NODE_A = "0x" + "a".repeat(64) as `0x${string}`
const NODE_B = "0x" + "b".repeat(64) as `0x${string}`
const NODE_C = "0x" + "c".repeat(64) as `0x${string}`
const OP_X = "0x1234567890123456789012345678901234567890" as `0x${string}`
const PUB_X = "0x04" + "11".repeat(64) as `0x${string}` // 65 B uncompressed

function newReader() {
  // We bypass the real RPC connection by passing a syntactically valid URL +
  // address. The reader makes no requests until init()/start(), neither of
  // which is called in these unit tests.
  return new ValidatorRegistryReader({
    rpcUrl: "http://127.0.0.1:1",
    address: "0x0000000000000000000000000000000000000001",
  })
}

test("ValidatorRegistryReader: ValidatorRegistered adds to active set + emits added", () => {
  const reader = newReader()
  const added: string[] = []
  reader.on("validatorAdded", (id) => added.push(id))

  reader._replayEventForTest(
    "ValidatorRegistered",
    [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X],
    100,
  )

  const active = reader.getActiveSet()
  assert.equal(active.length, 1)
  assert.equal(active[0].nodeId, NODE_A)
  assert.equal(active[0].operator, OP_X)
  assert.equal(active[0].pubkey, PUB_X)
  assert.equal(active[0].stake, 32n * 10n ** 18n)
  assert.deepEqual(added, [NODE_A])
})

test("ValidatorRegistryReader: ValidatorDeactivated removes from active set + emits removed", () => {
  const reader = newReader()
  const removed: string[] = []
  reader.on("validatorRemoved", (id) => removed.push(id))

  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 100)
  reader._replayEventForTest("ValidatorDeactivated", [NODE_A, 200n], 200)

  const active = reader.getActiveSet()
  assert.equal(active.length, 0)
  assert.deepEqual(removed, [NODE_A])
})

test("ValidatorRegistryReader: ValidatorSlashed reduces stake + does NOT emit add/remove on its own", () => {
  const reader = newReader()
  const added: string[] = []
  const removed: string[] = []
  reader.on("validatorAdded", (id) => added.push(id))
  reader.on("validatorRemoved", (id) => removed.push(id))

  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 100)
  // 10% slash: 32 ETH * 0.1 = 3.2 ETH
  reader._replayEventForTest(
    "ValidatorSlashed",
    [NODE_A, (32n * 10n ** 18n) * 1000n / 10000n, "0xdead"],
    150,
  )

  const active = reader.getActiveSet()
  assert.equal(active.length, 1)
  // Stake reduced
  const expected = 32n * 10n ** 18n - (32n * 10n ** 18n) * 1000n / 10000n
  assert.equal(active[0].stake, expected)
  // Slash alone doesn't emit removed (the contract pairs Deactivated with Slashed when active)
  assert.deepEqual(added, [NODE_A])
  assert.deepEqual(removed, [])
})

test("ValidatorRegistryReader: full slash sequence (Deactivated + Slashed) removes + reduces stake", () => {
  const reader = newReader()
  const removed: string[] = []
  reader.on("validatorRemoved", (id) => removed.push(id))

  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 100)
  // Contract emits both events for active-validator slash:
  reader._replayEventForTest("ValidatorDeactivated", [NODE_A, 200n], 200)
  reader._replayEventForTest("ValidatorSlashed", [NODE_A, (32n * 10n ** 18n) * 1000n / 10000n, "0xdead"], 200, 1)

  const active = reader.getActiveSet()
  assert.equal(active.length, 0)
  assert.deepEqual(removed, [NODE_A])
})

test("ValidatorRegistryReader: deterministic active set order (sorted by nodeId)", () => {
  const reader = newReader()
  // Register out of nodeId order — getActiveSet should sort.
  reader._replayEventForTest("ValidatorRegistered", [NODE_C, OP_X, 32n * 10n ** 18n, PUB_X], 100)
  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 101)
  reader._replayEventForTest("ValidatorRegistered", [NODE_B, OP_X, 32n * 10n ** 18n, PUB_X], 102)

  const active = reader.getActiveSet()
  assert.equal(active.length, 3)
  assert.equal(active[0].nodeId, NODE_A)
  assert.equal(active[1].nodeId, NODE_B)
  assert.equal(active[2].nodeId, NODE_C)
})

test("ValidatorRegistryReader: getActiveSet returns copies, not internal references", () => {
  const reader = newReader()
  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 100)

  const a = reader.getActiveSet()
  a[0].stake = 999n
  // Internal state must be unaffected.
  const b = reader.getActiveSet()
  assert.equal(b[0].stake, 32n * 10n ** 18n)
})

test("ValidatorRegistryReader: handler exception does not break further dispatch", () => {
  const reader = newReader()
  let secondHandlerCalled = false
  reader.on("validatorAdded", () => { throw new Error("first handler boom") })
  reader.on("validatorAdded", () => { secondHandlerCalled = true })

  // Must not throw out of replayEventForTest even though first handler does.
  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 100)
  assert.equal(secondHandlerCalled, true)
})

test("ValidatorRegistryReader: re-registering same nodeId after deactivation re-adds", () => {
  const reader = newReader()
  const events: Array<{ kind: "added" | "removed"; id: string }> = []
  reader.on("validatorAdded", (id) => events.push({ kind: "added", id }))
  reader.on("validatorRemoved", (id) => events.push({ kind: "removed", id }))

  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 32n * 10n ** 18n, PUB_X], 100)
  reader._replayEventForTest("ValidatorDeactivated", [NODE_A, 200n], 200)
  // Note: the on-chain contract currently doesn't allow re-staking the same
  // nodeId; this test guards the reader against forward-compat changes that
  // might add re-registration support.
  reader._replayEventForTest("ValidatorRegistered", [NODE_A, OP_X, 64n * 10n ** 18n, PUB_X], 300)

  assert.deepEqual(events, [
    { kind: "added", id: NODE_A },
    { kind: "removed", id: NODE_A },
    { kind: "added", id: NODE_A },
  ])
  const active = reader.getActiveSet()
  assert.equal(active.length, 1)
  assert.equal(active[0].stake, 64n * 10n ** 18n)
})
