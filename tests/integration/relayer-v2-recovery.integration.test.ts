import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { SlashEvidence } from "../../services/verifier/anti-cheat-policy.ts"
import { EvidenceStore } from "../../runtime/lib/evidence-store.ts"
import { PendingChallengeStore } from "../../runtime/lib/pending-challenge-store.ts"
import { PoseV2DisputeExecutor } from "../../runtime/lib/pose-v2-dispute-executor.ts"

function sampleEvidence(): SlashEvidence {
  return {
    nodeId: `0x${"33".repeat(32)}`,
    reasonCode: 3,
    evidenceHash: `0x${"44".repeat(32)}`,
    rawEvidence: {
      protocolVersion: 2,
      batchId: `0x${"11".repeat(32)}`,
      merkleProof: [`0x${"22".repeat(32)}`],
      evidenceLeaf: {
        epoch: "7",
        nodeId: `0x${"33".repeat(32)}`,
        nonce: `0x${"55".repeat(16)}`,
        tipHash: `0x${"66".repeat(32)}`,
        tipHeight: "99",
        latencyMs: 42,
        resultCode: 7,
        witnessBitmap: 3,
      },
      evidenceLeafHash: `0x${"44".repeat(32)}`,
      faultType: 4,
    },
  }
}

function createLogger() {
  return {
    info(_message: string, _data?: Record<string, unknown>) {},
    warn(_message: string, _data?: Record<string, unknown>) {},
  }
}

class FakePoseV2Contract {
  readonly interface = {
    parseLog(entry: { data?: string }) {
      if (!entry.data) throw new Error("missing log data")
      return { name: "ChallengeOpened", args: { challengeId: entry.data } }
    },
  }

  readonly challengesById = new Map<string, { revealed: boolean; settled: boolean; revealDeadlineEpoch: bigint }>()
  readonly openTxReceipts = new Map<string, { status: number; logs: Array<{ data: string }> }>()
  openCalls = 0
  revealCalls = 0
  settleCalls = 0
  failFirstOpenWait = true

  async openChallenge(_commitHash: string): Promise<{ hash: string; wait(): Promise<{ status: number; logs: Array<{ data: string }> }> }> {
    this.openCalls += 1
    const txHash = `0x${this.openCalls.toString(16).padStart(64, "0")}`
    const challengeId = `0x${(1000 + this.openCalls).toString(16).padStart(64, "0")}`
    this.challengesById.set(challengeId, {
      revealed: false,
      settled: false,
      revealDeadlineEpoch: 1n,
    })
    const receipt = { status: 1, logs: [{ data: challengeId }] }
    this.openTxReceipts.set(txHash, receipt)

    return {
      hash: txHash,
      wait: async () => {
        if (this.failFirstOpenWait) {
          this.failFirstOpenWait = false
          throw new Error("simulated crash after open tx broadcast")
        }
        return receipt
      },
    }
  }

  async revealChallenge(challengeId: string): Promise<{ hash: string; wait(): Promise<{ status: number }> }> {
    this.revealCalls += 1
    const record = this.challengesById.get(challengeId)
    if (!record) throw new Error("challenge not found")
    record.revealed = true
    return {
      hash: `0xreveal${this.revealCalls}`,
      wait: async () => ({ status: 1 }),
    }
  }

  async settleChallenge(challengeId: string): Promise<{ hash: string; wait(): Promise<{ status: number }> }> {
    this.settleCalls += 1
    const record = this.challengesById.get(challengeId)
    if (!record) throw new Error("challenge not found")
    record.settled = true
    return {
      hash: `0xsettle${this.settleCalls}`,
      wait: async () => ({ status: 1 }),
    }
  }

  async challenges(challengeId: string): Promise<{ revealed: boolean; settled: boolean; revealDeadlineEpoch: bigint } | undefined> {
    return this.challengesById.get(challengeId)
  }
}

test("relayer v2 recovery: evidence drain -> pending restore -> reveal -> settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coc-relayer-v2-recovery-"))
  const evidencePath = join(dir, "evidence-agent.jsonl")
  const pendingPath = join(dir, "pending-challenges-v2.json")
  const logger = createLogger()
  const contract = new FakePoseV2Contract()
  const provider = {
    async getTransactionReceipt(txHash: string) {
      return contract.openTxReceipts.get(txHash) ?? null
    },
  }
  const signer = {
    async signMessage(data: Uint8Array) {
      return `0x${Buffer.from(data).toString("hex").padEnd(130, "0").slice(0, 130)}`
    },
  }

  const evidenceStore = new EvidenceStore(1000, evidencePath)
  evidenceStore.push(sampleEvidence())
  assert.equal(evidenceStore.size, 1)

  const relayer1 = new PoseV2DisputeExecutor({
    contract,
    provider,
    signer,
    challengeBondWei: 100000000000000000n,
    store: new PendingChallengeStore(pendingPath),
    logger,
    getCurrentEpoch: () => 10,
  })

  const drained = evidenceStore.drain()
  assert.equal(drained.length, 1)
  await relayer1.processPending()
  await relayer1.processEvidenceBatch(drained)

  assert.equal(new EvidenceStore(1000, evidencePath).size, 0)
  assert.equal(new PendingChallengeStore(pendingPath).size, 1)
  assert.equal(contract.revealCalls, 0)
  assert.equal(contract.settleCalls, 0)

  const relayer2 = new PoseV2DisputeExecutor({
    contract,
    provider,
    signer,
    challengeBondWei: 100000000000000000n,
    store: new PendingChallengeStore(pendingPath),
    logger,
    getCurrentEpoch: () => 10,
  })

  await relayer2.processPending()
  assert.equal(contract.revealCalls, 1)
  assert.equal(new PendingChallengeStore(pendingPath).list()[0]?.state, "revealed")

  await relayer2.processPending()
  assert.equal(contract.settleCalls, 1)
  assert.equal(new PendingChallengeStore(pendingPath).size, 0)
})
