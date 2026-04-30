/**
 * Tests for runtime/lib/equivocation-detector-client.ts (Phase I3c).
 *
 * Mocks provider.getLogs + signer.sendTransaction to validate:
 *   - prime() walks ValidatorRegistered events into the address→nodeId map
 *   - resolveNodeId returns the cached nodeId; null when absent
 *   - submitEvidence builds calldata matching EquivocationDetector ABI and
 *     forwards to the signer
 *   - submitEvidence retries prime() once when validatorId is unknown,
 *     then bubbles a clear error if still missing
 */

import { test } from "node:test"
import assert from "node:assert"
import { Wallet, id as ethersId } from "ethers"
import type { Hex } from "../../node/src/blockchain-types.ts"
import type { EquivocationEvidence } from "../../node/src/bft.ts"
import {
  EquivocationDetectorClient,
  nodeIdTrailerAddress,
} from "./equivocation-detector-client.ts"
import { decodeSubmitEvidenceCall } from "./bft-slash-bridge.ts"

const REGISTRY = "0x0000000000000000000000000000000000000ABc"
const DETECTOR = "0x000000000000000000000000000000000000aBcD"

function bftCanonicalMessage(phase: string, height: bigint, blockHash: string): string {
  return `bft:${phase}:${height.toString()}:${blockHash}`
}

/**
 * Build the topic hash for ValidatorRegistered manually so the tests
 * don't depend on the Interface's hashing matching ours.
 */
const VALIDATOR_REGISTERED_TOPIC = ethersId("ValidatorRegistered(bytes32,address,uint256,bytes)")

interface FakeLog {
  topics: string[]
  data: string
  blockNumber: number
}

function makeRegisteredLog(nodeId: string, operator: string): FakeLog {
  // Topics: [topic0=eventSig, topic1=nodeId, topic2=operator]; data is the
  // ABI-encoded non-indexed args (uint256 stake, bytes pubkeyNode). Tests
  // don't read those — empty bytes32 + empty bytes is safe.
  const operatorPadded = ("0x" + "00".repeat(12) + operator.replace(/^0x/, "")) as string
  return {
    topics: [VALIDATOR_REGISTERED_TOPIC, nodeId, operatorPadded.toLowerCase()],
    data: "0x"
      + "0000000000000000000000000000000000000000000000000000000000000020" // stake offset
      + "0000000000000000000000000000000000000000000000000000000000000040" // pubkey offset
      + "0000000000000000000000000000000000000000000000000000000000000000" // stake = 0
      + "0000000000000000000000000000000000000000000000000000000000000000", // pubkey len 0
    blockNumber: 1,
  }
}

class FakeProvider {
  blockNumber: number = 100
  logs: FakeLog[] = []
  async getBlockNumber(): Promise<number> { return this.blockNumber }
  async getLogs(_filter: unknown): Promise<FakeLog[]> { return this.logs }
}

class FakeSigner {
  provider: FakeProvider
  txs: Array<{ to: string; data: string }> = []
  constructor(provider: FakeProvider) { this.provider = provider }
  async sendTransaction(tx: { to: string; data: string }): Promise<{
    hash: string
    wait: () => Promise<{ status: number }>
  }> {
    this.txs.push({ to: tx.to, data: tx.data })
    return {
      hash: "0x" + "ab".repeat(32),
      wait: async () => ({ status: 1 }),
    }
  }
}

async function makeEvidence(wallet: Wallet): Promise<{ evidence: EquivocationEvidence; nodeId: string }> {
  const phase = "prepare" as const
  const height = 42n
  const hashA = "0x" + "11".repeat(32)
  const hashB = "0x" + "22".repeat(32)
  const sigA = (await wallet.signMessage(bftCanonicalMessage(phase, height, hashA))) as Hex
  const sigB = (await wallet.signMessage(bftCanonicalMessage(phase, height, hashB))) as Hex
  const nodeId = "0x" + "00".repeat(12) + wallet.address.slice(2).toLowerCase()
  return {
    evidence: {
      validatorId: wallet.address.toLowerCase(),
      height,
      phase,
      blockHash1: hashA as Hex,
      blockHash2: hashB as Hex,
      detectedAtMs: 0,
      signature1: sigA,
      signature2: sigB,
    },
    nodeId,
  }
}

test("Phase I3c: nodeIdTrailerAddress extracts last 20 bytes as 0x address", () => {
  const nodeId = "0x" + "ff".repeat(12) + "f39fd6e51aad88f6f4ce6ab8827279cffFb92266".toLowerCase()
  const expected = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
  assert.strictEqual(nodeIdTrailerAddress(nodeId), expected)
})

test("Phase I3c: prime() populates address→nodeId from ValidatorRegistered logs", async () => {
  const provider = new FakeProvider()
  const signer = new FakeSigner(provider)
  const wallet = Wallet.createRandom()
  const trailer = wallet.address.toLowerCase()
  const nodeId = "0x" + "00".repeat(12) + trailer.slice(2)
  provider.logs = [makeRegisteredLog(nodeId, trailer)]

  const client = new EquivocationDetectorClient({
    signer: signer as unknown as import("ethers").AbstractSigner,
    registryAddress: REGISTRY,
    detectorAddress: DETECTOR,
    provider: provider as unknown as import("ethers").Provider,
  })

  const result = await client.prime()
  assert.ok(result.newEntries >= 1, "prime must register at least one entry")
  assert.strictEqual(client.resolveNodeId(trailer), nodeId)
  // Operator and nodeId-trailer point to the same address in this case so
  // the cache stores 1 unique key, not 2.
  assert.ok(client.cacheSize() >= 1)
})

test("Phase I3c: prime() is idempotent — second call returns 0 newEntries when no new logs", async () => {
  const provider = new FakeProvider()
  const signer = new FakeSigner(provider)
  const wallet = Wallet.createRandom()
  const trailer = wallet.address.toLowerCase()
  const nodeId = "0x" + "00".repeat(12) + trailer.slice(2)
  provider.logs = [makeRegisteredLog(nodeId, trailer)]

  const client = new EquivocationDetectorClient({
    signer: signer as unknown as import("ethers").AbstractSigner,
    registryAddress: REGISTRY,
    detectorAddress: DETECTOR,
    provider: provider as unknown as import("ethers").Provider,
  })

  await client.prime()
  // Re-priming with no new logs (FakeProvider returns same set, but
  // lastScannedBlock has advanced) yields 0 new entries and doesn't
  // duplicate cache entries.
  const r2 = await client.prime()
  assert.strictEqual(r2.newEntries, 0)
})

test("Phase I3c: submitEvidence builds correct ABI calldata and sends to detector", async () => {
  const provider = new FakeProvider()
  const signer = new FakeSigner(provider)
  const wallet = Wallet.createRandom()
  const trailer = wallet.address.toLowerCase()
  const nodeId = "0x" + "00".repeat(12) + trailer.slice(2)
  provider.logs = [makeRegisteredLog(nodeId, trailer)]

  const client = new EquivocationDetectorClient({
    signer: signer as unknown as import("ethers").AbstractSigner,
    registryAddress: REGISTRY,
    detectorAddress: DETECTOR,
    provider: provider as unknown as import("ethers").Provider,
  })

  await client.prime()
  const { evidence } = await makeEvidence(wallet)
  const result = await client.submitEvidence(evidence)
  assert.strictEqual(result.nodeId, nodeId)
  assert.ok(result.txHash.startsWith("0x"))
  assert.strictEqual(signer.txs.length, 1)
  assert.strictEqual(signer.txs[0].to.toLowerCase(), DETECTOR.toLowerCase())

  const decoded = decodeSubmitEvidenceCall(signer.txs[0].data)
  assert.strictEqual(decoded.nodeId.toLowerCase(), nodeId.toLowerCase())
  assert.strictEqual(decoded.phase, evidence.phase)
  assert.strictEqual(decoded.height, evidence.height)
  assert.strictEqual(decoded.hashA.toLowerCase(), evidence.blockHash1.toLowerCase())
  assert.strictEqual(decoded.hashB.toLowerCase(), evidence.blockHash2.toLowerCase())
})

test("Phase I3c: submitEvidence retries prime() when nodeId is unknown, then errors if still missing", async () => {
  const provider = new FakeProvider()
  const signer = new FakeSigner(provider)
  const wallet = Wallet.createRandom()
  // No logs registered → prime() finds nothing.

  const client = new EquivocationDetectorClient({
    signer: signer as unknown as import("ethers").AbstractSigner,
    registryAddress: REGISTRY,
    detectorAddress: DETECTOR,
    provider: provider as unknown as import("ethers").Provider,
  })

  const { evidence } = await makeEvidence(wallet)
  await assert.rejects(
    () => client.submitEvidence(evidence),
    /no nodeId for validator/,
  )
  assert.strictEqual(signer.txs.length, 0, "no tx sent on lookup miss")
})

test("Phase I3c: prime() resets when chain reorgs (provider blockNumber moves backwards)", async () => {
  const provider = new FakeProvider()
  const signer = new FakeSigner(provider)
  const wallet = Wallet.createRandom()
  const trailer = wallet.address.toLowerCase()
  const nodeId = "0x" + "00".repeat(12) + trailer.slice(2)
  provider.logs = [makeRegisteredLog(nodeId, trailer)]
  provider.blockNumber = 100

  const client = new EquivocationDetectorClient({
    signer: signer as unknown as import("ethers").AbstractSigner,
    registryAddress: REGISTRY,
    detectorAddress: DETECTOR,
    provider: provider as unknown as import("ethers").Provider,
  })

  const r1 = await client.prime()
  assert.ok(r1.newEntries >= 1)

  // Simulate backwards-jump (reorg, snapshot import, etc.)
  provider.blockNumber = 50
  const r2 = await client.prime()
  // Cache is reset and re-populated.
  assert.ok(r2.newEntries >= 1, "re-prime after reorg re-populates cache")
})
