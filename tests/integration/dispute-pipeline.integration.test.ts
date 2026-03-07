import test from "node:test"
import assert from "node:assert/strict"
import { EvidenceStore } from "../../runtime/lib/evidence-store.ts"
import { AntiCheatPolicy, EvidenceReason } from "../../services/verifier/anti-cheat-policy.ts"
import type { ChallengeMessage, ReceiptMessage } from "../../services/common/pose-types.ts"
import { encodeSlashEvidencePayload, hashSlashEvidencePayload, resolveEvidencePaths } from "../../services/common/slash-evidence.ts"

const challenge: ChallengeMessage = {
  challengeId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  epochId: 1n,
  nodeId: "0x2222222222222222222222222222222222222222222222222222222222222222",
  challengeType: "U",
  nonce: "0x1234567890abcdef1234567890abcdef",
  randSeed: "0x3333333333333333333333333333333333333333333333333333333333333333",
  issuedAtMs: 1000n,
  deadlineMs: 2500,
  querySpec: { method: "eth_blockNumber" },
  challengerId: "0x4444444444444444444444444444444444444444444444444444444444444444",
  challengerSig: "0xabc",
}

const receipt: ReceiptMessage = {
  challengeId: challenge.challengeId,
  nodeId: challenge.nodeId,
  responseAtMs: 1200n,
  responseBody: { result: "0x10" },
  nodeSig: "0xdef",
}

test("evidence store push and drain", () => {
  const store = new EvidenceStore()
  const policy = new AntiCheatPolicy()

  const evidence = policy.buildEvidence(EvidenceReason.InvalidSignature, challenge, receipt)
  store.push(evidence)

  assert.equal(store.size, 1)
  const drained = store.drain()
  assert.equal(drained.length, 1)
  assert.equal(drained[0].reasonCode, EvidenceReason.InvalidSignature)
  assert.equal(store.size, 0)
})

test("evidence store respects max size", () => {
  const store = new EvidenceStore(3)
  const policy = new AntiCheatPolicy()

  for (let i = 0; i < 5; i++) {
    const modified = { ...challenge, nonce: `0x${"0".repeat(30)}${i.toString(16).padStart(2, "0")}` as `0x${string}` }
    store.push(policy.buildEvidence(EvidenceReason.Timeout, modified))
  }

  assert.equal(store.size, 3)
})

test("invalid signature produces evidence with correct reason", () => {
  const policy = new AntiCheatPolicy()
  const evidence = policy.buildEvidence(EvidenceReason.InvalidSignature, challenge, receipt)

  assert.equal(evidence.reasonCode, EvidenceReason.InvalidSignature)
  assert.equal(evidence.nodeId, challenge.nodeId)
  assert.ok(evidence.evidenceHash.startsWith("0x"))
  assert.equal(evidence.rawEvidence.reasonCode, EvidenceReason.InvalidSignature)
})

test("timeout produces evidence with correct reason", () => {
  const policy = new AntiCheatPolicy()
  const lateReceipt = { ...receipt, responseAtMs: 9999n }
  const evidence = policy.buildEvidence(EvidenceReason.Timeout, challenge, lateReceipt)

  assert.equal(evidence.reasonCode, EvidenceReason.Timeout)
})

test("replay nonce produces evidence with correct reason", () => {
  const policy = new AntiCheatPolicy()
  const evidence = policy.buildEvidence(EvidenceReason.ReplayNonce, challenge, receipt)

  assert.equal(evidence.reasonCode, EvidenceReason.ReplayNonce)
})

test("missing receipt produces evidence without receipt data", () => {
  const policy = new AntiCheatPolicy()
  const evidence = policy.buildEvidence(EvidenceReason.MissingReceipt, challenge)

  assert.equal(evidence.reasonCode, EvidenceReason.MissingReceipt)
  assert.equal(evidence.rawEvidence.receiptNodeId, undefined)
})

test("drain returns items in order and empties store", () => {
  const store = new EvidenceStore()
  const policy = new AntiCheatPolicy()

  store.push(policy.buildEvidence(EvidenceReason.Timeout, challenge))
  store.push(policy.buildEvidence(EvidenceReason.InvalidSignature, challenge))
  store.push(policy.buildEvidence(EvidenceReason.ReplayNonce, challenge))

  const items = store.drain()
  assert.equal(items.length, 3)
  assert.equal(items[0].reasonCode, EvidenceReason.Timeout)
  assert.equal(items[1].reasonCode, EvidenceReason.InvalidSignature)
  assert.equal(items[2].reasonCode, EvidenceReason.ReplayNonce)
  assert.equal(store.size, 0)
})

test("evidence hash is deterministic", () => {
  const policy = new AntiCheatPolicy()
  const e1 = policy.buildEvidence(EvidenceReason.Timeout, challenge, receipt)
  const e2 = policy.buildEvidence(EvidenceReason.Timeout, challenge, receipt)

  assert.equal(e1.evidenceHash, e2.evidenceHash)
})

test("agent evidence hash matches relayer contract payload encoding", () => {
  const policy = new AntiCheatPolicy()
  const evidence = policy.buildEvidence(EvidenceReason.Timeout, challenge, receipt)
  const encoded = encodeSlashEvidencePayload(evidence.nodeId, evidence.rawEvidence)

  assert.equal(evidence.evidenceHash, hashSlashEvidencePayload(evidence.nodeId, evidence.rawEvidence))
  assert.equal(Buffer.from(encoded.subarray(0, 32)).toString("hex"), challenge.challengeId.slice(2))
  assert.equal(Buffer.from(encoded.subarray(32, 64)).toString("hex"), challenge.nodeId.slice(2))
})

test("evidence store drainFiltered preserves unmatched evidence for another pipeline", () => {
  const store = new EvidenceStore()
  const policy = new AntiCheatPolicy()
  const v1 = policy.buildEvidence(EvidenceReason.Timeout, challenge, receipt)
  const v2 = {
    ...policy.buildEvidence(EvidenceReason.InvalidSignature, challenge, receipt),
    rawEvidence: {
      ...policy.buildEvidence(EvidenceReason.InvalidSignature, challenge, receipt).rawEvidence,
      protocolVersion: 2,
    },
  }

  store.push(v1)
  store.push(v2)

  const drainedV2 = store.drainFiltered((evidence) => evidence.rawEvidence.protocolVersion === 2)
  assert.equal(drainedV2.length, 1)
  assert.equal(drainedV2[0].rawEvidence.protocolVersion, 2)
  assert.equal(store.size, 1)
  assert.equal(store.peek()[0].reasonCode, EvidenceReason.Timeout)
})

test("resolveEvidencePaths keeps legacy reads for BFT compatibility", () => {
  const paths = resolveEvidencePaths("/tmp/coc-evidence")
  assert.equal(paths.readPaths.length, 3)
  assert.ok(paths.readPaths[1].endsWith("evidence-agent.jsonl"))
  assert.ok(paths.readPaths[2].endsWith("evidence-bft.jsonl"))
})

test("peek returns items without removing", () => {
  const store = new EvidenceStore()
  const policy = new AntiCheatPolicy()

  store.push(policy.buildEvidence(EvidenceReason.Timeout, challenge))
  const peeked = store.peek()
  assert.equal(peeked.length, 1)
  assert.equal(store.size, 1)
})
