import { randomBytes } from "node:crypto"
import type { SlashEvidence } from "../../services/verifier/anti-cheat-policy.ts"
import { computeCommitHash, computeRevealDigest, encodeEvidenceData, extractV2FaultProofPayload, faultTypeForResultCode } from "./pose-v2-fault-proof.ts"
import { PendingChallengeStore, type PendingChallengeRecord } from "./pending-challenge-store.ts"

export interface PoseV2LogLike {
  topics?: readonly string[]
  data?: string
}

export interface PoseV2TxReceiptLike {
  status?: number | null
  logs?: PoseV2LogLike[]
}

export interface PoseV2TxLike {
  hash: string
  wait(): Promise<PoseV2TxReceiptLike | null | undefined>
}

export interface PoseV2ChallengeRecordLike {
  settled?: boolean
  revealed?: boolean
  revealDeadlineEpoch?: bigint | number
}

export interface PoseV2ContractLike {
  openChallenge(commitHash: string, overrides: { value: bigint }): Promise<PoseV2TxLike>
  revealChallenge(
    challengeId: string,
    targetNodeId: string,
    faultType: number,
    evidenceLeafHash: string,
    salt: string,
    evidenceData: string,
    challengerSig: string,
  ): Promise<PoseV2TxLike>
  settleChallenge(challengeId: string): Promise<PoseV2TxLike>
  challenges(challengeId: string): Promise<PoseV2ChallengeRecordLike | null | undefined>
  interface: {
    parseLog(entry: PoseV2LogLike): { name?: string; args?: Record<string, unknown> | unknown[] } | null
  }
}

export interface PoseV2ProviderLike {
  getTransactionReceipt(txHash: string): Promise<PoseV2TxReceiptLike | null>
}

export interface PoseV2SignerLike {
  signMessage(data: Uint8Array): Promise<string>
}

export interface PoseV2LoggerLike {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

export interface PoseV2DisputeExecutorOptions {
  contract: PoseV2ContractLike
  provider: PoseV2ProviderLike
  signer: PoseV2SignerLike
  challengeBondWei: bigint
  store: PendingChallengeStore
  logger: PoseV2LoggerLike
  getCurrentEpoch?: () => number
}

export class PoseV2DisputeExecutor {
  private readonly contract: PoseV2ContractLike
  private readonly provider: PoseV2ProviderLike
  private readonly signer: PoseV2SignerLike
  private readonly challengeBondWei: bigint
  private readonly store: PendingChallengeStore
  private readonly logger: PoseV2LoggerLike
  private readonly getCurrentEpoch: () => number
  private readonly pendingChallenges: Map<string, PendingChallengeRecord>

  constructor(options: PoseV2DisputeExecutorOptions) {
    this.contract = options.contract
    this.provider = options.provider
    this.signer = options.signer
    this.challengeBondWei = options.challengeBondWei
    this.store = options.store
    this.logger = options.logger
    this.getCurrentEpoch = options.getCurrentEpoch ?? (() => Math.floor(Date.now() / (60 * 60 * 1000)))
    this.pendingChallenges = new Map(this.store.list().map((record) => [record.commitHash, record]))
  }

  get pendingCount(): number {
    return this.pendingChallenges.size
  }

  async processPending(): Promise<void> {
    for (const pending of this.pendingChallenges.values()) {
      try {
        if (pending.state === "opening") {
          const recovered = await this.recoverOpenedChallenge(pending)
          if (!recovered) continue
        }
        if (!pending.challengeId) {
          this.logger.warn("pending v2 challenge missing challengeId", {
            commitHash: pending.commitHash,
            state: pending.state,
          })
          continue
        }
        if (pending.state === "committed") {
          await this.revealChallenge(pending)
        } else if (pending.state === "revealed") {
          await this.settleChallenge(pending)
        }
      } catch (error) {
        this.logger.warn("dispute lifecycle step failed", {
          challengeId: pending.challengeId,
          commitHash: pending.commitHash,
          state: pending.state,
          error: String(error),
        })
      }
    }
  }

  async processEvidenceBatch(evidenceBatch: SlashEvidence[]): Promise<void> {
    for (const evidence of evidenceBatch) {
      try {
        await this.openFromEvidence(evidence)
      } catch (error) {
        this.logger.warn("openV2Challenge failed", { nodeId: evidence.nodeId, error: String(error) })
      }
    }
  }

  async openFromEvidence(evidence: SlashEvidence): Promise<void> {
    const raw = evidence.rawEvidence
    if (!raw || typeof raw !== "object") {
      this.logger.warn("v2 challenge skipped: malformed raw evidence", { nodeId: evidence.nodeId })
      return
    }
    const payload = extractV2FaultProofPayload(raw)
    if (!payload) {
      this.logger.warn("v2 challenge skipped: evidence missing v2 fault-proof payload", { nodeId: evidence.nodeId })
      return
    }

    const faultType = payload.faultType ?? faultTypeForResultCode(Number(payload.evidenceLeaf.resultCode))
    if (faultType === 0) {
      this.logger.warn("v2 challenge skipped: unsupported fault type", {
        nodeId: evidence.nodeId,
        resultCode: payload.evidenceLeaf.resultCode,
      })
      return
    }

    const evidenceData = encodeEvidenceData(payload.batchId, payload.merkleProof, payload.evidenceLeaf)
    const salt = `0x${randomBytes(32).toString("hex")}`
    const targetNodeId = evidence.nodeId
    const evidenceLeafHash = payload.evidenceLeafHash ?? evidence.evidenceHash
    const commitHash = computeCommitHash(targetNodeId, faultType, evidenceLeafHash, salt)
    const tx = await this.contract.openChallenge(commitHash, { value: this.challengeBondWei })

    const pending: PendingChallengeRecord = {
      commitHash,
      salt,
      targetNodeId,
      faultType,
      evidenceLeafHash,
      evidenceData,
      challengerSig: "",
      state: "opening",
      createdAtMs: Date.now(),
      openTxHash: tx.hash,
    }
    this.upsert(pending)

    const receipt = await tx.wait()
    const challengeId = this.extractChallengeId(receipt?.logs ?? [])
    if (!challengeId) {
      throw new Error(`ChallengeOpened event not found for tx ${tx.hash}`)
    }

    const revealDigest = computeRevealDigest(
      challengeId,
      targetNodeId,
      faultType,
      evidenceLeafHash,
      salt,
      evidenceData,
    )
    pending.challengeId = challengeId
    pending.challengerSig = await this.signer.signMessage(Buffer.from(revealDigest.slice(2), "hex"))
    pending.state = "committed"
    this.upsert(pending)

    this.logger.info("v2 challenge opened", {
      challengeId,
      targetNodeId,
      faultType,
      bond: this.challengeBondWei.toString(),
      txHash: tx.hash,
    })
  }

  private upsert(record: PendingChallengeRecord): void {
    this.pendingChallenges.set(record.commitHash, record)
    this.store.upsert(record)
  }

  private remove(record: PendingChallengeRecord): void {
    this.pendingChallenges.delete(record.commitHash)
    this.store.remove(record.commitHash)
  }

  private async recoverOpenedChallenge(pending: PendingChallengeRecord): Promise<boolean> {
    if (pending.challengeId) {
      pending.state = "committed"
      this.upsert(pending)
      return true
    }
    if (!pending.openTxHash) {
      this.logger.warn("pending v2 challenge cannot recover: missing open tx hash", { commitHash: pending.commitHash })
      return false
    }

    const receipt = await this.provider.getTransactionReceipt(pending.openTxHash)
    if (!receipt) return false
    if (receipt.status === 0) {
      this.remove(pending)
      this.logger.warn("dropped pending v2 challenge after reverted open tx", {
        commitHash: pending.commitHash,
        txHash: pending.openTxHash,
      })
      return false
    }
    const challengeId = this.extractChallengeId(receipt.logs ?? [])
    if (!challengeId) {
      throw new Error(`ChallengeOpened event not found for tx ${pending.openTxHash}`)
    }

    const revealDigest = computeRevealDigest(
      challengeId,
      pending.targetNodeId,
      pending.faultType,
      pending.evidenceLeafHash,
      pending.salt,
      pending.evidenceData,
    )
    pending.challengeId = challengeId
    pending.challengerSig = pending.challengerSig
      || await this.signer.signMessage(Buffer.from(revealDigest.slice(2), "hex"))
    pending.state = "committed"
    this.upsert(pending)

    this.logger.info("recovered pending v2 challenge from open tx receipt", {
      challengeId,
      commitHash: pending.commitHash,
      txHash: pending.openTxHash,
    })
    return true
  }

  private async revealChallenge(pending: PendingChallengeRecord): Promise<void> {
    if (!pending.challengeId) return
    const record = await this.contract.challenges(pending.challengeId)
    if (record?.settled) {
      this.remove(pending)
      return
    }
    if (record?.revealed) {
      pending.state = "revealed"
      this.upsert(pending)
      return
    }

    const tx = await this.contract.revealChallenge(
      pending.challengeId,
      pending.targetNodeId,
      pending.faultType,
      pending.evidenceLeafHash,
      pending.salt,
      pending.evidenceData,
      pending.challengerSig,
    )
    await tx.wait()
    pending.state = "revealed"
    this.upsert(pending)
    this.logger.info("v2 challenge revealed", { challengeId: pending.challengeId, txHash: tx.hash })
  }

  private async settleChallenge(pending: PendingChallengeRecord): Promise<void> {
    if (!pending.challengeId) return
    const record = await this.contract.challenges(pending.challengeId)
    if (record?.settled) {
      this.remove(pending)
      return
    }
    if (!record?.revealed) return

    const revealDeadlineEpoch = Number(record.revealDeadlineEpoch ?? 0n)
    if (this.getCurrentEpoch() < revealDeadlineEpoch + 2) return

    try {
      const tx = await this.contract.settleChallenge(pending.challengeId)
      await tx.wait()
      this.remove(pending)
      this.logger.info("v2 challenge settled", { challengeId: pending.challengeId, txHash: tx.hash })
    } catch (error) {
      if (String(error).includes("AdjudicationWindowNotElapsed")) return
      throw error
    }
  }

  private extractChallengeId(logs: PoseV2LogLike[]): string | null {
    for (const entry of logs) {
      try {
        const parsed = this.contract.interface.parseLog(entry)
        if (parsed?.name === "ChallengeOpened") {
          const args = parsed.args as Record<string, unknown> | unknown[] | undefined
          if (!args) return null
          if (Array.isArray(args)) return String(args[0])
          return String(args.challengeId ?? args[0])
        }
      } catch {
        // ignore unrelated logs
      }
    }
    return null
  }
}
