import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_EVIDENCE_FILENAME,
  LEGACY_AGENT_EVIDENCE_FILENAME,
  LEGACY_BFT_EVIDENCE_FILENAME,
  encodeSlashEvidencePayload,
  extractEvidenceChallengeId,
  hashSlashEvidencePayload,
  resolveEvidencePaths,
  stableStringifyEvidence,
} from "./slash-evidence.ts"

test("resolveEvidencePaths prefers shared file and reads legacy files", () => {
  const paths = resolveEvidencePaths("/tmp/coc")
  assert.equal(paths.writePath, "/tmp/coc/" + DEFAULT_EVIDENCE_FILENAME)
  assert.deepEqual(paths.readPaths, [
    "/tmp/coc/" + DEFAULT_EVIDENCE_FILENAME,
    "/tmp/coc/" + LEGACY_AGENT_EVIDENCE_FILENAME,
    "/tmp/coc/" + LEGACY_BFT_EVIDENCE_FILENAME,
  ])
})

test("resolveEvidencePaths honors explicit override", () => {
  const paths = resolveEvidencePaths("/tmp/coc", "/tmp/custom/evidence.jsonl")
  assert.equal(paths.writePath, "/tmp/custom/evidence.jsonl")
  assert.deepEqual(paths.readPaths, ["/tmp/custom/evidence.jsonl"])
})

test("stableStringifyEvidence sorts object keys recursively", () => {
  const result = stableStringifyEvidence({
    z: 1,
    a: { y: true, x: ["b", "a"] },
  })
  assert.equal(result, "{\"a\":{\"x\":[\"b\",\"a\"],\"y\":true},\"z\":1}")
})

test("encodeSlashEvidencePayload prefixes challengeId and nodeId headers", () => {
  const nodeId = `0x${"22".repeat(32)}` as `0x${string}`
  const challengeId = `0x${"11".repeat(32)}` as `0x${string}`
  const payload = encodeSlashEvidencePayload(nodeId, {
    challengeId,
    reasonCode: 3,
    detail: "timeout",
  })
  assert.equal(Buffer.from(payload.subarray(0, 32)).toString("hex"), "11".repeat(32))
  assert.equal(Buffer.from(payload.subarray(32, 64)).toString("hex"), "22".repeat(32))
  assert.match(Buffer.from(payload.subarray(64)).toString("utf8"), /"reasonCode":3/)
})

test("hashSlashEvidencePayload is deterministic and aligned with encoded payload", () => {
  const nodeId = `0x${"33".repeat(32)}` as `0x${string}`
  const rawEvidence = {
    challengeId: `0x${"44".repeat(32)}`,
    nodeId,
    reasonCode: 6,
    phase: "commit",
  }
  const h1 = hashSlashEvidencePayload(nodeId, rawEvidence)
  const h2 = hashSlashEvidencePayload(nodeId, { ...rawEvidence })
  assert.equal(h1, h2)
  assert.equal(extractEvidenceChallengeId(rawEvidence), rawEvidence.challengeId)
})

test("extractEvidenceChallengeId falls back to zero bytes32", () => {
  assert.equal(
    extractEvidenceChallengeId({ challengeId: "0x1234" }),
    `0x${"0".repeat(64)}`,
  )
})
