// Reward manifest: shared data structure persisted by agent, consumed by relayer.
// Enables the authoritative reward pipeline: agent → file → relayer → contract.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { verifyTypedData } from "ethers"
import { REWARD_MANIFEST_TYPES } from "../../node/src/crypto/eip712-types.ts"

export interface RewardLeafEntry {
  nodeId: string
  amount: string // stringified bigint
}

export interface ChallengerRewardEntry {
  challengerAddress: string
  nodeId?: string
  challengeCount: number
  validReceiptCount: number
}

export interface ChallengerRewardSettlementEntry extends ChallengerRewardEntry {
  amount?: string
  reason?: string
}

export interface RewardManifest {
  epochId: number
  rewardRoot: string
  totalReward: string // stringified bigint
  slashTotal: string
  treasuryDelta: string
  leaves: RewardLeafEntry[]
  proofs: Record<string, string[]> // key: "epochId:nodeId" → proof hashes
  scoringInputsHash: string
  generatedAtMs: number
  challengerRewards?: ChallengerRewardEntry[]
  sourceNodeCount?: number
  scoredNodeCount?: number
  missingNodeIds?: string[]
  settled?: boolean
  sourceTotalReward?: string
  settlementBudgetWei?: string
  settledAtMs?: number
  distributionTxHash?: string
  distributionBlockNumber?: number
  skippedInactiveNodeIds?: string[]
  appliedChallengerRewards?: ChallengerRewardSettlementEntry[]
  skippedChallengerRewards?: ChallengerRewardSettlementEntry[]
  finalizeTxHash?: string
  finalizeBlockNumber?: number
  generatorSignature?: string
  generatorAddress?: string
}

export function stableStringifyForHash(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyForHash(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyForHash(obj[key])}`).join(",")}}`;
}

export function writeRewardManifest(dir: string, manifest: RewardManifest): string {
  mkdirSync(dir, { recursive: true })
  const path = rewardManifestPath(dir, manifest.epochId)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest, null, 2))
  renameSync(tmp, path)
  return path
}

export function writeSettledRewardManifest(dir: string, manifest: RewardManifest): string {
  mkdirSync(dir, { recursive: true })
  const path = settledRewardManifestPath(dir, manifest.epochId)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...manifest, settled: true }, null, 2))
  renameSync(tmp, path)
  return path
}

export function readRewardManifest(dir: string, epochId: number): RewardManifest | null {
  const path = rewardManifestPath(dir, epochId)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    return JSON.parse(raw) as RewardManifest
  } catch {
    return null
  }
}

export function readSettledRewardManifest(dir: string, epochId: number): RewardManifest | null {
  const path = settledRewardManifestPath(dir, epochId)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    return JSON.parse(raw) as RewardManifest
  } catch {
    return null
  }
}

export function readBestRewardManifest(dir: string, epochId: number): RewardManifest | null {
  return readSettledRewardManifest(dir, epochId) ?? readRewardManifest(dir, epochId)
}

export function rewardManifestPath(dir: string, epochId: number): string {
  return `${dir}/reward-epoch-${epochId}.json`
}

export function settledRewardManifestPath(dir: string, epochId: number): string {
  return `${dir}/reward-epoch-${epochId}.settled.json`
}

export interface RewardClaimView {
  epochId: number
  nodeId: string
  amount: string
  proof: string[]
  rewardRoot: string
  totalReward: string
  settled: boolean
}

export function lookupRewardClaim(manifest: RewardManifest, nodeId: string): RewardClaimView | null {
  const normalizedNodeIds = candidateManifestNodeIds(nodeId)
  const leaf = manifest.leaves.find((entry) => normalizedNodeIds.has(normalizeManifestNodeId(entry.nodeId)))
  if (!leaf) return null

  for (const candidate of normalizedNodeIds) {
    const proof = manifest.proofs[`${manifest.epochId}:${candidate}`]
    if (proof) {
      return {
        epochId: manifest.epochId,
        nodeId: candidate,
        amount: leaf.amount,
        proof,
        rewardRoot: manifest.rewardRoot,
        totalReward: manifest.totalReward,
        settled: manifest.settled === true,
      }
    }
  }

  return null
}

function candidateManifestNodeIds(nodeId: string): Set<string> {
  const normalized = normalizeManifestNodeId(nodeId)
  const candidates = new Set<string>([normalized])
  if (normalized.length === 66) {
    const address = `0x${normalized.slice(-40)}`
    candidates.add(address)
  } else if (normalized.length === 42) {
    candidates.add(`0x${normalized.slice(2).padStart(64, "0")}`)
  }
  return candidates
}

function normalizeManifestNodeId(nodeId: string): string {
  return nodeId.toLowerCase()
}

export interface ManifestSigningPayload {
  epochId: bigint
  rewardRoot: string
  totalReward: bigint
  scoringInputsHash: string
}

export function manifestSigningPayload(manifest: RewardManifest): ManifestSigningPayload {
  return {
    epochId: BigInt(manifest.epochId),
    rewardRoot: manifest.rewardRoot,
    totalReward: BigInt(manifest.totalReward),
    scoringInputsHash: manifest.scoringInputsHash,
  }
}

export interface ManifestVerifyResult {
  valid: boolean
  recoveredAddress?: string
  error?: string
}

export function verifyManifestSignature(
  manifest: RewardManifest,
  domain: { name: string; version: string; chainId: bigint | number; verifyingContract: string },
): ManifestVerifyResult {
  if (!manifest.generatorSignature) {
    return { valid: false, error: "missing" }
  }

  try {
    const payload = manifestSigningPayload(manifest)
    const recovered = verifyTypedData(domain, REWARD_MANIFEST_TYPES, payload, manifest.generatorSignature)
    const recoveredLower = recovered.toLowerCase()

    if (manifest.generatorAddress && recoveredLower !== manifest.generatorAddress.toLowerCase()) {
      return { valid: false, recoveredAddress: recoveredLower, error: "address_mismatch" }
    }

    return { valid: true, recoveredAddress: recoveredLower }
  } catch (err) {
    return { valid: false, error: `verify_failed: ${String(err)}` }
  }
}
