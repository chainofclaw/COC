import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Wallet } from "ethers"
import { createEip712Signer } from "../node/src/crypto/eip712-signer.ts"
import {
  buildDomain,
  CHALLENGE_TYPES,
  RECEIPT_TYPES,
  WITNESS_TYPES,
} from "../node/src/crypto/eip712-types.ts"
import { createNodeSignerV2 } from "../node/src/crypto/signer.ts"
import { ChallengeFactoryV2 } from "../services/challenger/challenge-factory-v2.ts"
import { BatchAggregatorV2 } from "../services/aggregator/batch-aggregator-v2.ts"
import { computeEpochRewards } from "../services/verifier/scoring.ts"
import { buildRewardRoot, hashRewardLeaf, buildRewardTree } from "../services/common/reward-tree.ts"
import { ResultCode } from "../services/common/pose-types-v2.ts"
import type { Hex32 } from "../services/common/pose-types.ts"
import type { VerifiedReceiptV2, WitnessAttestation, ChallengeMessageV2 } from "../services/common/pose-types-v2.ts"
import { keccak256Hex } from "../services/relayer/keccak256.ts"

const KEY1 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const KEY2 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const KEY3 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
const CHAIN_ID = 20241224n
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${props.join(",")}}`
}

describe("PoSe v2 E2E flow", () => {
  const domain = buildDomain(CHAIN_ID, CONTRACT)

  it("full pipeline: challenge → receipt → witness → batch → reward", async () => {
    // 1. Setup challenger, node, witness
    const challengerWallet = new Wallet(KEY1)
    const challengerSigner = createEip712Signer(challengerWallet, domain)
    const challengerId = `0x${challengerWallet.address.slice(2).toLowerCase().padStart(64, "0")}` as Hex32

    const nodeWallet = new Wallet(KEY2)
    const nodeSigner = createNodeSignerV2(KEY2, domain)
    const nodeId = `0x${nodeWallet.address.slice(2).toLowerCase().padStart(64, "0")}` as Hex32

    const witnessWallet = new Wallet(KEY3)
    const witnessSigner = createEip712Signer(witnessWallet, domain)

    // 2. Issue v2 challenge
    const factory = new ChallengeFactoryV2({
      challengerId,
      eip712Signer: challengerSigner,
    })

    const challenge = await factory.issue({
      epochId: 100n,
      nodeId,
      challengeType: "Uptime",
      issuedAtMs: BigInt(Date.now()),
      querySpec: { method: "eth_blockNumber" },
      challengeNonce: 42n,
    })

    assert.equal(challenge.version, 2)
    assert.ok(challenge.challengerSig.startsWith("0x"))

    // 3. Node signs receipt with EIP-712
    const responseBody = { ok: true, blockNumber: 1000 }
    const responseBodyHash = `0x${keccak256Hex(Buffer.from(stableStringify(responseBody), "utf8"))}` as Hex32
    const tipHash = `0x${"aa".repeat(32)}` as Hex32
    const tipHeight = 999n
    const responseAtMs = BigInt(Date.now())

    const receiptSig = await nodeSigner.eip712.signTypedData(RECEIPT_TYPES, {
      challengeId: challenge.challengeId,
      nodeId,
      responseAtMs,
      responseBodyHash,
      tipHash,
      tipHeight,
    })

    // 4. Witness signs attestation
    const witnessAttest = {
      challengeId: challenge.challengeId,
      nodeId,
      responseBodyHash,
      witnessIndex: 0,
    }
    const witnessSig = await witnessSigner.signTypedData(WITNESS_TYPES, witnessAttest)

    const witnessAttestation: WitnessAttestation = {
      challengeId: challenge.challengeId,
      nodeId,
      responseBodyHash,
      witnessIndex: 0,
      attestedAtMs: BigInt(Date.now()),
      witnessSig: witnessSig as `0x${string}`,
    }

    // 5. Build verified receipt
    const evidenceLeaf = {
      epoch: 100n,
      nodeId,
      nonce: challenge.nonce,
      tipHash,
      tipHeight,
      latencyMs: 50,
      resultCode: ResultCode.Ok as typeof ResultCode.Ok,
      witnessBitmap: 1, // bit 0
    }

    const verified: VerifiedReceiptV2 = {
      challenge,
      receipt: {
        challengeId: challenge.challengeId,
        nodeId,
        responseAtMs,
        responseBody,
        responseBodyHash,
        tipHash,
        tipHeight,
        nodeSig: receiptSig as `0x${string}`,
      },
      witnesses: [witnessAttestation],
      witnessBitmap: 1,
      evidenceLeaf,
      verifiedAtMs: BigInt(Date.now()),
    }

    // 6. Batch aggregation
    const aggregator = new BatchAggregatorV2({ sampleSize: 1 })
    const batch = aggregator.buildBatch(100n, [verified])

    assert.ok(batch.merkleRoot.startsWith("0x"))
    assert.equal(batch.merkleRoot.length, 66)
    assert.equal(batch.sampleProofs.length, 1)
    assert.equal(batch.witnessBitmap, 1)

    // 7. Compute rewards
    const stats = [{
      nodeId,
      uptimeBps: 10000,
      storageBps: 0,
      relayBps: 0,
      storageGb: 0n,
    }]
    const rewardPool = 1000000000000000000n // 1 ETH
    const scoringResult = computeEpochRewards(rewardPool, stats)

    assert.ok(scoringResult.rewards[nodeId] > 0n)

    // 8. Build reward tree
    const { root, leaves, proofs } = buildRewardRoot(100n, scoringResult)
    assert.ok(root.startsWith("0x"))
    assert.equal(root.length, 66)
    assert.equal(leaves.length, 1)
    assert.ok(proofs.size > 0)
  })

  it("multiple nodes produce deterministic reward root", async () => {
    const node1 = `0x${"aa".repeat(32)}` as Hex32
    const node2 = `0x${"bb".repeat(32)}` as Hex32

    const stats = [
      { nodeId: node1, uptimeBps: 9500, storageBps: 8000, relayBps: 6000, storageGb: 10n },
      { nodeId: node2, uptimeBps: 9800, storageBps: 7500, relayBps: 5500, storageGb: 20n },
    ]

    const pool = 2000000000000000000n
    const r1 = computeEpochRewards(pool, stats)
    const r2 = computeEpochRewards(pool, stats)

    const tree1 = buildRewardRoot(50n, r1)
    const tree2 = buildRewardRoot(50n, r2)

    assert.equal(tree1.root, tree2.root)
    assert.deepEqual(tree1.leaves, tree2.leaves)
  })

  it("witness quorum bitmap tracks correctly", async () => {
    const domain = buildDomain(CHAIN_ID, CONTRACT)
    const witnessKeys = [KEY1, KEY2, KEY3]
    const witnessSigners = witnessKeys.map((k) => createEip712Signer(new Wallet(k), domain))

    const challengeId = `0x${"ab".repeat(32)}` as Hex32
    const nodeId = `0x${"cd".repeat(32)}` as Hex32
    const responseBodyHash = `0x${"ee".repeat(32)}` as Hex32

    let bitmap = 0
    for (let i = 0; i < witnessSigners.length; i++) {
      const attestData = { challengeId, nodeId, responseBodyHash, witnessIndex: i }
      const sig = await witnessSigners[i].signTypedData(WITNESS_TYPES, attestData)
      assert.ok(sig.startsWith("0x"))
      bitmap |= (1 << i)
    }

    assert.equal(bitmap, 0b111) // all 3 witnesses
    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }
    assert.equal(count, 3)
  })
})
