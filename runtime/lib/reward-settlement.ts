import { buildRewardTree } from "../../services/common/reward-tree.ts"
import type { RewardLeaf } from "../../services/common/pose-types-v2.ts"
import { readRewardManifest, type RewardManifest } from "./reward-manifest.ts"

const BPS_DENOMINATOR = 10_000n

// --- Manifest loading & validation (shared by V1 distributeRewards and V2 finalizeEpochV2) ---

export interface ManifestValidationResult {
  status: "ok" | "not_found" | "empty" | "incomplete_coverage"
  manifest: RewardManifest | null
  missingNodeIds?: string[]
}

export function loadAndValidateManifest(
  manifestDir: string,
  epochId: number,
  opts?: { allowEmpty?: boolean },
): ManifestValidationResult {
  const manifest = readRewardManifest(manifestDir, epochId)
  if (!manifest) {
    return { status: "not_found", manifest: null }
  }
  if (!opts?.allowEmpty && manifest.leaves.length === 0) {
    return { status: "empty", manifest }
  }
  if ((manifest.missingNodeIds?.length ?? 0) > 0) {
    return { status: "incomplete_coverage", manifest, missingNodeIds: manifest.missingNodeIds }
  }
  return { status: "ok", manifest }
}

export interface V1RewardPlanEntry {
  nodeId: string
  amount: bigint
}

export interface V1RewardPlan {
  rewards: V1RewardPlanEntry[]
  totalDistributed: bigint
  skippedInactiveNodeIds: string[]
}

export function createSettledRewardManifest(manifest: RewardManifest, budgetWei: bigint): RewardManifest {
  const sourceTotalReward = BigInt(manifest.totalReward)
  const effectiveBudget = budgetWei < sourceTotalReward ? budgetWei : sourceTotalReward
  const scaledLeaves = scaleLeaves(manifest, effectiveBudget, sourceTotalReward)
  const rewardLeaves: RewardLeaf[] = scaledLeaves
    .filter((leaf) => leaf.amount > 0n)
    .map((leaf) => ({
      epochId: BigInt(manifest.epochId),
      nodeId: toBytes32NodeId(leaf.nodeId),
      amount: leaf.amount,
    }))
  const tree = buildRewardTree(rewardLeaves)

  return {
    ...manifest,
    rewardRoot: tree.root,
    totalReward: effectiveBudget.toString(),
    leaves: rewardLeaves.map((leaf) => ({ nodeId: leaf.nodeId, amount: leaf.amount.toString() })),
    proofs: Object.fromEntries([...tree.proofs.entries()].map(([key, proof]) => [key, proof as string[]])),
    settled: true,
    sourceTotalReward: manifest.totalReward,
    settlementBudgetWei: budgetWei.toString(),
    settledAtMs: Date.now(),
  }
}

export function createV1SettledManifest(
  originalManifest: RewardManifest,
  plan: V1RewardPlan,
  poolBalance: bigint,
  opts: { distributionTxHash: string; distributionBlockNumber?: number },
): RewardManifest {
  return {
    ...originalManifest,
    rewardRoot: originalManifest.rewardRoot,
    totalReward: plan.totalDistributed.toString(),
    leaves: plan.rewards.map((r) => ({ nodeId: r.nodeId, amount: r.amount.toString() })),
    settled: true,
    sourceTotalReward: originalManifest.totalReward,
    settlementBudgetWei: poolBalance.toString(),
    settledAtMs: Date.now(),
    distributionTxHash: opts.distributionTxHash,
    distributionBlockNumber: opts.distributionBlockNumber,
    skippedInactiveNodeIds: plan.skippedInactiveNodeIds,
  }
}

export async function planV1RewardDistribution(
  manifest: RewardManifest,
  poolBalance: bigint,
  isActiveNode: (nodeId: string) => Promise<boolean> | boolean,
  maxPerNodeBps = 3000n,
): Promise<V1RewardPlan> {
  const sourceTotalReward = BigInt(manifest.totalReward)
  const effectivePool = poolBalance < sourceTotalReward ? poolBalance : sourceTotalReward
  const scaledLeaves = scaleLeaves(manifest, effectivePool, sourceTotalReward)
  const maxPerNode = (poolBalance * maxPerNodeBps) / BPS_DENOMINATOR

  const rewards: V1RewardPlanEntry[] = []
  const skippedInactiveNodeIds: string[] = []
  let totalDistributed = 0n

  for (const leaf of scaledLeaves) {
    const nodeId = toBytes32NodeId(leaf.nodeId)
    if (!await isActiveNode(nodeId)) {
      skippedInactiveNodeIds.push(nodeId)
      continue
    }

    let amount = leaf.amount
    if (amount > maxPerNode) {
      amount = maxPerNode
    }
    if (totalDistributed + amount > poolBalance) {
      amount = poolBalance - totalDistributed
    }
    if (amount <= 0n) {
      continue
    }

    rewards.push({ nodeId, amount })
    totalDistributed += amount
  }

  return {
    rewards,
    totalDistributed,
    skippedInactiveNodeIds,
  }
}

function scaleLeaves(manifest: RewardManifest, budgetWei: bigint, sourceTotalReward: bigint): Array<{ nodeId: string; amount: bigint; rawAmount: bigint }> {
  if (budgetWei <= 0n || sourceTotalReward <= 0n || manifest.leaves.length === 0) {
    return manifest.leaves.map((leaf) => ({ nodeId: leaf.nodeId, amount: 0n, rawAmount: BigInt(leaf.amount) }))
  }

  const leaves = manifest.leaves.map((leaf) => ({
    nodeId: leaf.nodeId,
    rawAmount: BigInt(leaf.amount),
    amount: 0n,
  }))
  let distributed = 0n

  for (const leaf of leaves) {
    if (leaf.rawAmount <= 0n) {
      continue
    }
    leaf.amount = (leaf.rawAmount * budgetWei) / sourceTotalReward
    distributed += leaf.amount
  }

  let remainder = budgetWei - distributed
  if (remainder > 0n) {
    const ranked = [...leaves].sort((a, b) =>
      a.rawAmount === b.rawAmount
        ? a.nodeId.localeCompare(b.nodeId)
        : a.rawAmount > b.rawAmount ? -1 : 1,
    )
    for (const leaf of ranked) {
      if (leaf.rawAmount <= 0n) continue
      leaf.amount += 1n
      remainder -= 1n
      if (remainder === 0n) break
    }
  }

  return leaves
}

function toBytes32NodeId(nodeId: string): string {
  const normalized = nodeId.toLowerCase()
  if (normalized.length === 42) {
    return `0x${normalized.slice(2).padStart(64, "0")}`
  }
  return normalized
}
