/**
 * Tests for runtime/lib/pose-slash-total-scanner.ts (Phase I4b).
 *
 * Mocks an ethers Provider to feed ChallengeRevealed logs + view-call
 * results, validates the scanner's epoch filter + per-node aggregation
 * + final reduction via I4a's pure helper.
 */

import { test } from "node:test"
import assert from "node:assert"
import { Interface, id as ethersId, AbiCoder } from "ethers"
import { PoSeSlashTotalScanner } from "./pose-slash-total-scanner.ts"

const POSE = "0x" + "11".repeat(20)
const NODE_A = "0x" + "00".repeat(12) + "aa".repeat(20)
const NODE_B = "0x" + "00".repeat(12) + "bb".repeat(20)

const SCANNER_ABI = [
  "event ChallengeRevealed(bytes32 indexed challengeId, bytes32 targetNodeId, uint8 faultType)",
  "function challengeFaultConfirmed(bytes32) view returns (bool)",
  "function challenges(bytes32) view returns (tuple(bytes32 commitHash, address challenger, uint256 bond, uint64 commitEpoch, uint64 revealDeadlineEpoch, bool revealed, bool settled, bytes32 targetNodeId, uint8 faultType))",
  "function getNode(bytes32) view returns (tuple(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, uint256 bondAmount, bytes32 metadataHash, uint64 registeredAtEpoch, uint64 unlockEpoch, bool active))",
  "function epochNodeSlashed(uint64 epoch, bytes32 nodeId) view returns (uint256)",
] as const
const iface = new Interface(SCANNER_ABI as unknown as string[])

const CHALLENGE_REVEALED_TOPIC = ethersId("ChallengeRevealed(bytes32,bytes32,uint8)")

interface FakeLog { topics: string[]; data: string; blockNumber: number }

function makeRevealLog(challengeId: string, targetNodeId: string, faultType: number): FakeLog {
  // Build the log: topic0 = event sig hash; topic1 = challengeId (indexed).
  // data = ABI-encoded (targetNodeId, faultType).
  const dataPart = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8"],
    [targetNodeId, faultType],
  )
  return {
    topics: [CHALLENGE_REVEALED_TOPIC, challengeId],
    data: dataPart,
    blockNumber: 1,
  }
}

function encodeChallengeRecord(targetNodeId: string, commitEpoch: bigint) {
  return iface.encodeFunctionResult("challenges", [
    {
      commitHash: "0x" + "00".repeat(32),
      challenger: "0x" + "00".repeat(20),
      bond: 0n,
      commitEpoch,
      revealDeadlineEpoch: 0n,
      revealed: true,
      settled: false,
      targetNodeId,
      faultType: 4,
    },
  ])
}

function encodeNodeRecord(bondAmount: bigint) {
  return iface.encodeFunctionResult("getNode", [
    {
      nodeId: "0x" + "00".repeat(32),
      pubkeyNode: "0x",
      serviceFlags: 0,
      serviceCommitment: "0x" + "00".repeat(32),
      endpointCommitment: "0x" + "00".repeat(32),
      bondAmount,
      metadataHash: "0x" + "00".repeat(32),
      registeredAtEpoch: 0n,
      unlockEpoch: 0n,
      active: true,
    },
  ])
}

class FakeProvider {
  blockNumber = 1000
  logs: FakeLog[] = []
  // Queues of view-call return data, keyed by function selector (first 4 bytes of calldata).
  // For each call we pop the next response in order; tests pre-load the queue.
  responses = new Map<string, string[]>()
  async getBlockNumber(): Promise<number> { return this.blockNumber }
  async getLogs(_f: unknown): Promise<FakeLog[]> { return this.logs }
  async call(req: { to: string; data: string }): Promise<string> {
    const selector = req.data.slice(0, 10)
    const queue = this.responses.get(selector) ?? []
    const ret = queue.shift()
    if (ret === undefined) {
      throw new Error(`FakeProvider: no queued response for selector ${selector}`)
    }
    this.responses.set(selector, queue)
    return ret
  }
  enqueue(funcName: string, encodedReturn: string): void {
    const selector = iface.getFunction(funcName)!.selector
    if (!this.responses.has(selector)) this.responses.set(selector, [])
    this.responses.get(selector)!.push(encodedReturn)
  }
}

const challengeFaultConfirmedTrue = iface.encodeFunctionResult("challengeFaultConfirmed", [true])
const challengeFaultConfirmedFalse = iface.encodeFunctionResult("challengeFaultConfirmed", [false])

test("Phase I4b: empty epoch returns 0", async () => {
  const provider = new FakeProvider()
  const scanner = new PoSeSlashTotalScanner({
    provider: provider as unknown as import("ethers").Provider,
    poseManagerV2Address: POSE,
  })
  assert.strictEqual(await scanner.computeSlashTotalForEpoch(7n), 0n)
})

test("Phase I4b: single fault-confirmed challenge in target epoch contributes its expected slash", async () => {
  const provider = new FakeProvider()
  const challengeId = "0x" + "33".repeat(32)
  provider.logs = [makeRevealLog(challengeId, NODE_A, 4)]
  // 1) challengeFaultConfirmed → true
  provider.enqueue("challengeFaultConfirmed", challengeFaultConfirmedTrue)
  // 2) challenges(...) → commitEpoch=42, targetNodeId=NODE_A
  provider.enqueue("challenges", encodeChallengeRecord(NODE_A, 42n))
  // 3) epochNodeSlashed(42, NODE_A) → 0
  provider.enqueue("epochNodeSlashed", iface.encodeFunctionResult("epochNodeSlashed", [0n]))
  // 4) getNode(NODE_A) → bondAmount = 1 ETH
  provider.enqueue("getNode", encodeNodeRecord(1_000_000_000_000_000_000n))

  const scanner = new PoSeSlashTotalScanner({
    provider: provider as unknown as import("ethers").Provider,
    poseManagerV2Address: POSE,
  })
  const total = await scanner.computeSlashTotalForEpoch(42n)
  // 10% of 1 ETH = 0.1 ETH
  assert.strictEqual(total, 100_000_000_000_000_000n)
})

test("Phase I4b: filters out challenges from other epochs", async () => {
  const provider = new FakeProvider()
  const cidA = "0x" + "33".repeat(32)
  const cidB = "0x" + "44".repeat(32)
  provider.logs = [makeRevealLog(cidA, NODE_A, 4), makeRevealLog(cidB, NODE_B, 4)]
  // Both confirmed
  provider.enqueue("challengeFaultConfirmed", challengeFaultConfirmedTrue)
  provider.enqueue("challengeFaultConfirmed", challengeFaultConfirmedTrue)
  // cidA is in epoch 42 (target), cidB is in epoch 43 (off-target)
  provider.enqueue("challenges", encodeChallengeRecord(NODE_A, 42n))
  provider.enqueue("challenges", encodeChallengeRecord(NODE_B, 43n))
  // Only cidA reaches the bond/slash reads
  provider.enqueue("epochNodeSlashed", iface.encodeFunctionResult("epochNodeSlashed", [0n]))
  provider.enqueue("getNode", encodeNodeRecord(1_000_000_000_000_000_000n))

  const scanner = new PoSeSlashTotalScanner({
    provider: provider as unknown as import("ethers").Provider,
    poseManagerV2Address: POSE,
  })
  const total = await scanner.computeSlashTotalForEpoch(42n)
  assert.strictEqual(total, 100_000_000_000_000_000n)
})

test("Phase I4b: skips unconfirmed challenges (challengeFaultConfirmed=false)", async () => {
  const provider = new FakeProvider()
  const challengeId = "0x" + "55".repeat(32)
  provider.logs = [makeRevealLog(challengeId, NODE_A, 4)]
  provider.enqueue("challengeFaultConfirmed", challengeFaultConfirmedFalse)
  // No further reads expected because the confirmed check short-circuits.

  const scanner = new PoSeSlashTotalScanner({
    provider: provider as unknown as import("ethers").Provider,
    poseManagerV2Address: POSE,
  })
  const total = await scanner.computeSlashTotalForEpoch(42n)
  assert.strictEqual(total, 0n)
})

test("Phase I4b: same-node multiple challenges share the per-epoch cap", async () => {
  // Two confirmed challenges on the SAME nodeId in the SAME epoch — the
  // pure helper's running-cap logic ensures we only count 10% once.
  const provider = new FakeProvider()
  const cid1 = "0x" + "66".repeat(32)
  const cid2 = "0x" + "77".repeat(32)
  provider.logs = [makeRevealLog(cid1, NODE_A, 4), makeRevealLog(cid2, NODE_A, 4)]
  provider.enqueue("challengeFaultConfirmed", challengeFaultConfirmedTrue)
  provider.enqueue("challengeFaultConfirmed", challengeFaultConfirmedTrue)
  provider.enqueue("challenges", encodeChallengeRecord(NODE_A, 42n))
  provider.enqueue("challenges", encodeChallengeRecord(NODE_A, 42n))
  // First challenge populates the slashed cache; second hits the cache.
  provider.enqueue("epochNodeSlashed", iface.encodeFunctionResult("epochNodeSlashed", [0n]))
  provider.enqueue("getNode", encodeNodeRecord(1_000_000_000_000_000_000n))
  provider.enqueue("getNode", encodeNodeRecord(1_000_000_000_000_000_000n))

  const scanner = new PoSeSlashTotalScanner({
    provider: provider as unknown as import("ethers").Provider,
    poseManagerV2Address: POSE,
  })
  const total = await scanner.computeSlashTotalForEpoch(42n)
  assert.strictEqual(total, 100_000_000_000_000_000n, "shared 10% cap, not 20%")
})
