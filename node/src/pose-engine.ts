import { ChallengeFactory, buildChallengeVerifyPayload } from "../../services/challenger/challenge-factory.ts"
import { ChallengeQuota } from "../../services/challenger/challenge-quota.ts"
import { ReceiptVerifier } from "../../services/verifier/receipt-verifier.ts"
import { NonceRegistry } from "../../services/verifier/nonce-registry.ts"
import { BatchAggregator } from "../../services/aggregator/batch-aggregator.ts"
import { computeEpochRewards } from "../../services/verifier/scoring.ts"
import type { ChallengeMessage, Hex32, ReceiptMessage, VerifiedReceipt } from "../../services/common/pose-types.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { buildReceiptSignMessage } from "./crypto/signer.ts"

export interface PoSeEngineDeps {
  signer: NodeSigner & SignatureVerifier
}

function addressToHex32(address: string): Hex32 {
  const clean = address.startsWith("0x") ? address.slice(2) : address
  return `0x${clean.padStart(64, "0")}` as Hex32
}

function hex32ToAddress(hex32: string): string {
  const clean = hex32.startsWith("0x") ? hex32.slice(2) : hex32
  // Take the last 40 hex chars (20 bytes) as Ethereum address
  return `0x${clean.slice(-40)}`.toLowerCase()
}

export class PoSeEngine {
  private readonly quota: ChallengeQuota
  private readonly factory: ChallengeFactory
  private readonly verifier: ReceiptVerifier
  private readonly aggregator: BatchAggregator
  private readonly receipts: VerifiedReceipt[] = []
  private readonly signer: NodeSigner & SignatureVerifier
  private epochId: bigint

  constructor(epochId: bigint, deps: PoSeEngineDeps) {
    this.signer = deps.signer
    const challengerHex32 = addressToHex32(this.signer.nodeId)
    this.quota = new ChallengeQuota({
      maxPerEpoch: { U: 6, S: 2, R: 2 },
      minIntervalMs: { U: 1000, S: 2000, R: 2000 }
    })
    this.factory = new ChallengeFactory({
      challengerId: challengerHex32,
      sign: (digestHex) => {
        return this.signer.sign(digestHex) as `0x${string}`
      }
    })
    this.verifier = new ReceiptVerifier({
      nonceRegistry: new NonceRegistry(),
      verifyChallengerSig: (challenge) => {
        const payload = buildChallengeVerifyPayload(challenge)
        const challengerAddr = hex32ToAddress(challenge.challengerId)
        return this.signer.verifyNodeSig(payload, challenge.challengerSig, challengerAddr)
      },
      verifyNodeSig: (challenge, receipt, responseBodyHash) => {
        const msg = buildReceiptSignMessage(
          challenge.challengeId,
          receipt.nodeId,
          responseBodyHash,
        )
        const nodeAddr = hex32ToAddress(receipt.nodeId)
        return this.signer.verifyNodeSig(msg, receipt.nodeSig, nodeAddr)
      },
      verifyUptimeResult: () => true
    })
    this.aggregator = new BatchAggregator({
      sampleSize: 2,
      signSummary: (s) => this.signer.sign(s)
    })
    this.epochId = epochId
  }

  getEpochId(): bigint {
    return this.epochId
  }

  issueChallenge(nodeId: string): ChallengeMessage | null {
    const can = this.quota.canIssue(nodeId as Hex32, this.epochId, "U", BigInt(Date.now()))
    if (!can.ok) return null
    const challenge = this.factory.issue({
      epochId: this.epochId,
      nodeId: nodeId as Hex32,
      challengeType: "Uptime",
      randSeed: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex32,
      issuedAtMs: BigInt(Date.now()),
      querySpec: { method: "eth_blockNumber" }
    })
    this.quota.commitIssue(nodeId as Hex32, this.epochId, "U", BigInt(Date.now()))
    return challenge
  }

  submitReceipt(challenge: ChallengeMessage, receipt: ReceiptMessage): void {
    const verified = this.verifier.toVerifiedReceipt(challenge, receipt, BigInt(Date.now()))
    this.receipts.push(verified)
  }

  finalizeEpoch(): { summaryHash: string; merkleRoot: string; rewards: Record<string, bigint> } | null {
    if (this.receipts.length === 0) return null
    const batch = this.aggregator.buildBatch(this.epochId, this.receipts)
    const rewards = computeEpochRewards(1_000_000n, [
      { nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex32, uptimeBps: 9000, storageBps: 0, relayBps: 0, storageGb: 0n }
    ])
    this.receipts.length = 0
    this.epochId += 1n
    return { summaryHash: batch.summaryHash, merkleRoot: batch.merkleRoot, rewards: rewards.rewards }
  }
}
