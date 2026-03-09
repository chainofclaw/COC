import { join } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { EvidenceStore } from "./lib/evidence-store.ts";
import { PendingChallengeStore } from "./lib/pending-challenge-store.ts";
import { PoseV2DisputeExecutor } from "./lib/pose-v2-dispute-executor.ts";
import {
  writeSettledRewardManifest,
  verifyManifestSignature,
  type ChallengerRewardEntry,
  type ChallengerRewardSettlementEntry,
} from "./lib/reward-manifest.ts";
import type { SlashEvidence } from "../services/verifier/anti-cheat-policy.ts";
import { createLogger } from "../node/src/logger.ts";
import { buildDomain } from "../node/src/crypto/eip712-types.ts";
import { ContractReader } from "./lib/contract-reader.ts";
import { encodeSlashEvidencePayload, resolveEvidencePaths } from "../services/common/slash-evidence.ts";
import { resolvePrivateKey } from "./lib/key-material.ts";
import { retryAsync } from "./lib/retry.ts";
import { createSettledRewardManifest, createV1SettledManifest, loadAndValidateManifest, planV1RewardDistribution } from "./lib/reward-settlement.ts";
import { resolveFinalizationCandidate } from "./lib/epoch-utils.ts";
import { allocateChallengerRewards } from "../services/relayer/epoch-finalizer.ts";
import {
  buildBftEquivocationSlashEvidence,
  normalizeEquivocationRpcEntry,
  type EquivocationEvidence,
} from "./lib/bft-equivocation.ts";

const log = createLogger("coc-relayer");

const config = await loadConfig();
const intervalMs = Number(process.env.COC_RELAYER_INTERVAL_MS || config.relayerIntervalMs || 60000);
const l1Rpc = process.env.COC_L1_RPC_URL || config.l1RpcUrl || "http://127.0.0.1:8545";
const poseManagerAddress = process.env.COC_POSE_MANAGER || config.poseManagerAddress;
const hasSlasherKeySource = Boolean(
  process.env.COC_SLASHER_PK
  || process.env.COC_SLASHER_PK_FILE
  || config.slasherPrivateKey
  || config.slasherPrivateKeyFile
  || config.operatorPrivateKey
  || config.operatorPrivateKeyFile,
);
const slasherPk = hasSlasherKeySource
  ? resolvePrivateKey({
      envValue: process.env.COC_SLASHER_PK,
      envFilePath: process.env.COC_SLASHER_PK_FILE,
      configValue: config.slasherPrivateKey ?? config.operatorPrivateKey,
      configFilePath: config.slasherPrivateKeyFile ?? config.operatorPrivateKeyFile,
      label: "slasher",
    })
  : undefined;
const txRetryOptions = {
  retries: Math.max(0, Number(process.env.COC_TX_RETRY_ATTEMPTS || (config.txRetryAttempts ?? 2))),
  baseDelayMs: Math.max(1, Number(process.env.COC_TX_RETRY_BASE_DELAY_MS || (config.txRetryBaseDelayMs ?? 250))),
  maxDelayMs: Math.max(1, Number(process.env.COC_TX_RETRY_MAX_DELAY_MS || (config.txRetryMaxDelayMs ?? 5000))),
  onRetry: (error: unknown, attempt: number, delayMs: number) => {
    log.warn("retrying relayer tx operation", { attempt, delayMs, error: String(error) });
  },
};

const provider = new JsonRpcProvider(l1Rpc);
const signer = slasherPk ? new Wallet(slasherPk, provider) : null;

const poseAbi = [
  "function getEpochBatchIds(uint64 epochId) view returns (bytes32[])",
  "function getBatch(bytes32 batchId) view returns (tuple(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, address aggregator, uint64 submittedAtEpoch, uint64 disputeDeadlineEpoch, bool finalized, bool disputed))",
  "function finalizeEpoch(uint64 epochId)",
  "function challengeBatch(bytes32 batchId, bytes32 receiptLeaf, bytes32[] merkleProof, bytes invalidityEvidence)",
  "function slash(bytes32 nodeId, tuple(bytes32 nodeId, uint8 reasonCode, bytes32 evidenceHash, bytes rawEvidence) evidence)",
  "function distributeRewards(uint64 epochId, tuple(bytes32 nodeId, uint256 amount)[] rewards)",
  "function getNode(bytes32 nodeId) view returns (tuple(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, uint256 bondAmount, bytes32 metadataHash, uint64 registeredAtEpoch, uint64 unlockEpoch, bool active))",
  "function rewardPoolBalance() view returns (uint256)",
];

const pose = poseManagerAddress && signer ? new Contract(poseManagerAddress, poseAbi, signer) : null;
let lastFinalizeEpoch = 0;

// --- v2 Protocol Setup ---
const useV2 = config.protocolVersion === 2;
const v2ChainId = config.chainId ?? 20241224;
const v2VerifyingContract = config.verifyingContract ?? config.poseManagerV2Address ?? "0x0000000000000000000000000000000000000000";
const v2Domain = useV2 ? buildDomain(BigInt(v2ChainId), v2VerifyingContract) : null;
const poseV2Address = config.poseManagerV2Address;

const poseV2Abi = [
  "function finalizeEpochV2(uint64 epochId, bytes32 rewardRoot, uint256 totalReward, uint256 slashTotal, uint256 treasuryDelta)",
  "function openChallenge(bytes32 commitHash) payable returns (bytes32 challengeId)",
  "function revealChallenge(bytes32 challengeId, bytes32 targetNodeId, uint8 faultType, bytes32 evidenceLeafHash, bytes32 salt, bytes evidenceData, bytes challengerSig)",
  "function settleChallenge(bytes32 challengeId)",
  "function getEpochBatchIds(uint64 epochId) view returns (bytes32[])",
  "function epochFinalized(uint64 epochId) view returns (bool)",
  "function epochRewardRoots(uint64 epochId) view returns (bytes32)",
  "function rewardPoolBalance() view returns (uint256)",
  "function initEpochNonce(uint64 epochId)",
  "function challengeNonces(uint64 epochId) view returns (uint64)",
  "function challenges(bytes32 challengeId) view returns (tuple(bytes32 commitHash, address challenger, uint256 bond, uint64 commitEpoch, uint64 revealDeadlineEpoch, bool revealed, bool settled, bytes32 targetNodeId, uint8 faultType))",
];

const poseV2Contract = poseV2Address && signer ? new Contract(poseV2Address, poseV2Abi, signer) : null;
const challengeBondWei = BigInt(config.challengeBondWei ?? "100000000000000000"); // 0.1 ETH

const contractReader = useV2 ? new ContractReader({
  l2RpcUrl: config.l2RpcUrl ?? l1Rpc,
  poseManagerV2Address: poseV2Address,
}) : null;

const rewardManifestDir = config.rewardManifestDir ?? join(config.dataDir, "reward-manifests");
const pendingChallengesPath = process.env.COC_PENDING_CHALLENGES_PATH
  || config.pendingChallengesPath
  || join(config.dataDir, "pending-challenges-v2.json");

const evidenceStores = resolveEvidencePaths(config.dataDir, process.env.COC_EVIDENCE_PATH)
  .readPaths
  .map((path) => new EvidenceStore(1000, path));
const pendingChallengeStore = new PendingChallengeStore(pendingChallengesPath);
const disputeExecutor = poseV2Contract && signer
  ? new PoseV2DisputeExecutor({
      contract: poseV2Contract,
      provider,
      signer,
      challengeBondWei,
      store: pendingChallengeStore,
      logger: log,
      retryOptions: txRetryOptions,
    })
  : null;

let tickInProgress = false;
let tickOverlapSkipped = 0;

if (disputeExecutor && disputeExecutor.pendingCount > 0) {
  log.info("restored pending v2 challenges from disk", {
    count: disputeExecutor.pendingCount,
    path: pendingChallengesPath,
  });
}

async function tick(): Promise<void> {
  if (tickInProgress) {
    tickOverlapSkipped += 1;
    log.warn("tick skipped: previous tick still in progress", { tickOverlapSkipped });
    return;
  }
  tickInProgress = true;
  try {
    if (useV2) {
      await tryInitEpochNonce();
      await tryFinalizeV2();
      await tryPollBftEquivocations();
      await tryDispute();
      await tryDisputeV2();
    } else {
      await tryFinalize();
      await tryPollBftEquivocations();
      await tryDispute();
    }
    log.info("tick ok");
  } catch (error) {
    log.error("tick failed", { error: String(error) });
  } finally {
    tickInProgress = false;
  }
}

async function tryFinalize(): Promise<void> {
  if (!pose) {
    return;
  }

  const candidate = resolveFinalizationCandidate(lastFinalizeEpoch);
  if (candidate === null) {
    return;
  }

  const batchIds: string[] = await pose.getEpochBatchIds(BigInt(candidate));
  if (batchIds.length === 0) {
    lastFinalizeEpoch = candidate;
    return;
  }

  const tx = await retryAsync(() => pose.finalizeEpoch(BigInt(candidate)), txRetryOptions);
  const receipt = await retryAsync(() => tx.wait(), txRetryOptions);
  lastFinalizeEpoch = candidate;

  log.info("finalized", {
    epochId: candidate,
    txHash: tx.hash,
    status: receipt?.status,
    batches: batchIds.length,
  });

  // Distribute rewards after successful finalization using the persisted scoring manifest.
  try {
    await tryDistributeRewards(candidate, batchIds);
  } catch (error) {
    log.warn("reward distribution failed (non-fatal)", { epochId: candidate, error: String(error) });
  }
}

function toBytes32NodeId(nodeId: string): string {
  const normalized = nodeId.toLowerCase();
  if (normalized.length === 42) {
    return `0x${normalized.slice(2).padStart(64, "0")}`;
  }
  return normalized;
}

function aggregateChallengerRewards(entries: ChallengerRewardEntry[]): ChallengerRewardEntry[] {
  const aggregated = new Map<string, ChallengerRewardEntry>();
  for (const entry of entries) {
    const challengerAddress = entry.challengerAddress.toLowerCase();
    const existing = aggregated.get(challengerAddress);
    if (!existing) {
      aggregated.set(challengerAddress, {
        challengerAddress,
        nodeId: entry.nodeId,
        challengeCount: entry.challengeCount,
        validReceiptCount: entry.validReceiptCount,
      });
      continue;
    }
    existing.challengeCount += entry.challengeCount;
    existing.validReceiptCount += entry.validReceiptCount;
    if (!existing.nodeId && entry.nodeId) {
      existing.nodeId = entry.nodeId;
    }
  }
  return [...aggregated.values()];
}

async function tryDistributeRewards(epochId: number, _batchIds: string[]): Promise<void> {
  if (!pose) return;

  const validation = loadAndValidateManifest(rewardManifestDir, epochId);
  if (validation.status !== "ok") {
    log.warn("v1 reward distribution skipped", { epochId, reason: validation.status, missingNodeIds: validation.missingNodeIds });
    return;
  }
  const manifest = validation.manifest!;

  // Signature verification (V1: warn only, non-blocking)
  if (v2Domain && manifest.generatorSignature) {
    const sigResult = verifyManifestSignature(manifest, v2Domain);
    if (sigResult.valid) {
      log.info("v1 manifest signature valid", { epochId, signer: sigResult.recoveredAddress });
    } else {
      log.warn("v1 manifest signature invalid", { epochId, error: sigResult.error });
    }
  } else if (!manifest.generatorSignature) {
    log.warn("v1 manifest has no signature", { epochId });
  }

  const poolBalance: bigint = await retryAsync(() => pose.rewardPoolBalance() as Promise<bigint>, txRetryOptions);
  if (poolBalance === 0n) {
    log.info("reward pool empty, skipping distribution", { epochId });
    return;
  }

  const challengerShareBps = Number(process.env.COC_CHALLENGER_SHARE_BPS || (config.challengerShareBps ?? 500));
  const challengerInputs = aggregateChallengerRewards(manifest.challengerRewards ?? []);
  const skippedChallengerRewards: ChallengerRewardSettlementEntry[] = [];
  const claimableChallengers: ChallengerRewardEntry[] = [];
  for (const entry of challengerInputs) {
    if (!entry.nodeId) {
      skippedChallengerRewards.push({ ...entry, reason: "missing_node_id" });
      continue;
    }
    const nodeId = toBytes32NodeId(entry.nodeId);
    const node = await retryAsync(() => pose.getNode(nodeId), txRetryOptions);
    if (!node?.active) {
      skippedChallengerRewards.push({ ...entry, nodeId, reason: "inactive_node" });
      continue;
    }
    claimableChallengers.push({ ...entry, nodeId });
  }
  const challengerBatches = claimableChallengers
    .map((entry) => ({
      challenger: entry.challengerAddress.toLowerCase(),
      challengeCount: entry.validReceiptCount > 0 ? entry.validReceiptCount : entry.challengeCount,
      validReceiptCount: entry.validReceiptCount,
    }))
    .filter((entry) => entry.challengeCount > 0);
  const challengerRewards = allocateChallengerRewards(challengerBatches, poolBalance, challengerShareBps);
  const reservedChallengerBudget = [...challengerRewards.values()].reduce((sum, amount) => sum + amount, 0n);
  const nodeRewardBudget = reservedChallengerBudget >= poolBalance ? 0n : poolBalance - reservedChallengerBudget;
  const plan = await planV1RewardDistribution(
    manifest,
    nodeRewardBudget,
    async (nodeId) => {
      const node = await retryAsync(() => pose.getNode(nodeId), txRetryOptions);
      return Boolean(node?.active);
    },
  );

  if (plan.rewards.length === 0 && challengerRewards.size === 0) return;

  const maxPerNode = (poolBalance * 3000n) / 10000n;
  const mergedRewards = [...plan.rewards.map((entry) => ({ ...entry }))];
  const appliedChallengerRewards: ChallengerRewardSettlementEntry[] = [];
  let mergedTotal = plan.totalDistributed;
  for (const entry of claimableChallengers) {
    const reward = challengerRewards.get(entry.challengerAddress.toLowerCase()) ?? 0n;
    if (reward <= 0n) {
      continue;
    }
    const nodeId = toBytes32NodeId(entry.nodeId ?? "");
    const existing = mergedRewards.find((item) => item.nodeId.toLowerCase() === nodeId);
    const existingAmount = existing?.amount ?? 0n;
    let amount = reward;
    if (existingAmount >= maxPerNode) {
      skippedChallengerRewards.push({ ...entry, nodeId, amount: reward.toString(), reason: "per_node_cap_reached" });
      continue;
    }
    if (existingAmount + amount > maxPerNode) {
      amount = maxPerNode - existingAmount;
    }
    if (mergedTotal + amount > poolBalance) {
      amount = poolBalance - mergedTotal;
    }
    if (amount <= 0n) {
      skippedChallengerRewards.push({ ...entry, nodeId, amount: reward.toString(), reason: "pool_budget_exhausted" });
      continue;
    }
    if (existing) {
      existing.amount += amount;
    } else {
      mergedRewards.push({ nodeId, amount });
    }
    mergedTotal += amount;
    appliedChallengerRewards.push({ ...entry, nodeId, amount: amount.toString() });
  }

  if (mergedRewards.length === 0) {
    log.info("reward distribution skipped after challenger merge", {
      epochId,
      skippedChallengerRewards: skippedChallengerRewards.length,
    });
    return;
  }

  if (challengerRewards.size > 0 || skippedChallengerRewards.length > 0) {
    log.info("challenger rewards merged into distribution", {
      epochId,
      challengersRequested: challengerRewards.size,
      challengersApplied: appliedChallengerRewards.length,
      challengersSkipped: skippedChallengerRewards.length,
      totalChallengerReward: appliedChallengerRewards.reduce((sum, entry) => sum + BigInt(entry.amount ?? "0"), 0n).toString(),
    });
  }

  const rewardTx = await retryAsync(() => pose.distributeRewards(BigInt(epochId), mergedRewards), txRetryOptions);
  const rewardReceipt = await retryAsync(() => rewardTx.wait(), txRetryOptions);
  log.info("rewards distributed (scoring + challenger)", {
    epochId,
    nodes: mergedRewards.length,
    pool: poolBalance.toString(),
    manifestTotal: manifest.totalReward,
    distributedTotal: mergedTotal.toString(),
    challengerRewardsAllocated: appliedChallengerRewards.length,
    skippedInactiveNodeIds: plan.skippedInactiveNodeIds,
    txHash: rewardTx.hash,
    status: rewardReceipt?.status,
  });

  try {
    const settled = createV1SettledManifest(manifest, {
      rewards: mergedRewards,
      totalDistributed: mergedTotal,
      skippedInactiveNodeIds: plan.skippedInactiveNodeIds,
    }, poolBalance, {
      distributionTxHash: rewardTx.hash,
      distributionBlockNumber: rewardReceipt?.blockNumber,
    });
    settled.appliedChallengerRewards = appliedChallengerRewards;
    settled.skippedChallengerRewards = skippedChallengerRewards;
    writeSettledRewardManifest(rewardManifestDir, settled);
  } catch (settleErr) {
    log.warn("v1 settled manifest write failed (non-fatal)", { epochId, error: String(settleErr) });
  }
}

async function tryDispute(): Promise<void> {
  if (!pose) {
    return;
  }

  const evidenceBatch = drainEvidenceBatch((evidence) => !isV2Evidence(evidence));
  if (evidenceBatch.length === 0) {
    return;
  }

  for (const evidence of evidenceBatch) {
    try {
      await submitSlash(evidence);
    } catch (error) {
      log.error("slash failed", { nodeId: evidence.nodeId, error: String(error) });
    }
  }
}

export function encodeSlashEvidenceForContract(evidence: SlashEvidence): Uint8Array {
  return encodeSlashEvidencePayload(evidence.nodeId, evidence.rawEvidence);
}

async function submitSlash(evidence: SlashEvidence): Promise<void> {
  if (!pose) {
    return;
  }

  const rawBytes = encodeSlashEvidenceForContract(evidence);
  const tx = await retryAsync(() => pose.slash(evidence.nodeId, {
    nodeId: evidence.nodeId,
    reasonCode: evidence.reasonCode,
    evidenceHash: evidence.evidenceHash,
    rawEvidence: rawBytes,
  }), txRetryOptions);
  const receipt = await retryAsync(() => tx.wait(), txRetryOptions);

  log.info("slashed", {
    nodeId: evidence.nodeId,
    reasonCode: evidence.reasonCode,
    txHash: tx.hash,
    status: receipt?.status,
  });
}

// --- v2 Epoch Nonce Initialization ---
let lastNonceInitEpoch = 0;

async function tryInitEpochNonce(): Promise<void> {
  if (!poseV2Contract) return;

  const currentEpoch = Math.floor(Date.now() / (60 * 60 * 1000));
  if (currentEpoch <= lastNonceInitEpoch) return;

  try {
    const existing: bigint = await retryAsync(() => poseV2Contract.challengeNonces(BigInt(currentEpoch)) as Promise<bigint>, txRetryOptions);
    if (existing !== 0n) {
      lastNonceInitEpoch = currentEpoch;
      return;
    }

    const tx = await retryAsync(() => poseV2Contract.initEpochNonce(BigInt(currentEpoch)), txRetryOptions);
    await retryAsync(() => tx.wait(), txRetryOptions);
    lastNonceInitEpoch = currentEpoch;
    log.info("epoch nonce initialized", { epochId: currentEpoch, txHash: tx.hash });
  } catch (error) {
    log.warn("initEpochNonce failed", { epochId: currentEpoch, error: String(error) });
  }
}

// --- v2 Finalization ---
async function tryFinalizeV2(): Promise<void> {
  if (!poseV2Contract) return;

  const candidate = resolveFinalizationCandidate(lastFinalizeEpoch);
  if (candidate === null) return;

  try {
    const isFinalized = await poseV2Contract.epochFinalized(BigInt(candidate));
    if (isFinalized) {
      lastFinalizeEpoch = candidate;
      return;
    }
  } catch { /* proceed to try finalize */ }

  try {
    const batchIds: string[] = await poseV2Contract.getEpochBatchIds(BigInt(candidate));

    let rewardRoot = "0x" + "0".repeat(64);
    let totalReward = 0n;
    let slashTotal = 0n;
    let treasuryDelta = 0n;
    let settledManifestToPersist: ReturnType<typeof createSettledRewardManifest> | null = null;

    if (batchIds.length > 0) {
      const validation = loadAndValidateManifest(rewardManifestDir, candidate, { allowEmpty: true });
      if (validation.status !== "ok") {
        log.warn("finalizeV2 skipped", { epochId: candidate, reason: validation.status, batches: batchIds.length, missingNodeIds: validation.missingNodeIds });
        return;
      }
      const manifest = validation.manifest!;

      // Signature verification (V2: reject on invalid signature)
      if (v2Domain && manifest.generatorSignature) {
        const sigResult = verifyManifestSignature(manifest, v2Domain);
        if (sigResult.valid) {
          log.info("v2 manifest signature valid", { epochId: candidate, signer: sigResult.recoveredAddress });
        } else {
          log.error("v2 manifest signature invalid — rejecting", { epochId: candidate, error: sigResult.error });
          return;
        }
      } else if (!manifest.generatorSignature) {
        log.warn("v2 manifest has no signature (backward compat)", { epochId: candidate });
      }

      const poolBalance: bigint = await retryAsync(() => poseV2Contract.rewardPoolBalance() as Promise<bigint>, txRetryOptions);
      const settledManifest = createSettledRewardManifest(manifest, poolBalance);
      settledManifestToPersist = settledManifest;
      rewardRoot = settledManifest.rewardRoot;
      totalReward = BigInt(settledManifest.totalReward);
      slashTotal = BigInt(manifest.slashTotal);
      treasuryDelta = BigInt(manifest.treasuryDelta);
      log.info("reward manifest loaded", {
        epochId: candidate,
        rewardRoot,
        totalReward: totalReward.toString(),
        leaves: settledManifest.leaves.length,
        sourceTotalReward: manifest.totalReward,
        poolBalance: poolBalance.toString(),
      });

    }

    const tx = await retryAsync(
      () => poseV2Contract.finalizeEpochV2(
        BigInt(candidate),
        rewardRoot,
        totalReward,
        slashTotal,
        treasuryDelta,
      ),
      txRetryOptions,
    );
    const receipt = await retryAsync(() => tx.wait(), txRetryOptions);
    lastFinalizeEpoch = candidate;

    log.info("finalizedV2", {
      epochId: candidate,
      txHash: tx.hash,
      status: receipt?.status,
      batches: batchIds.length,
      totalReward: totalReward.toString(),
    });
    if (settledManifestToPersist) {
      try {
        settledManifestToPersist = {
          ...settledManifestToPersist,
          finalizeTxHash: tx.hash,
          finalizeBlockNumber: receipt?.blockNumber,
        };
        writeSettledRewardManifest(rewardManifestDir, settledManifestToPersist);
      } catch (error) {
        log.warn("failed to persist settled reward manifest after finalizeV2", {
          epochId: candidate,
          error: String(error),
        });
      }
    }
  } catch (error) {
    log.error("finalizeV2 failed", { epochId: candidate, error: String(error) });
  }
}

async function tryDisputeV2(): Promise<void> {
  if (!disputeExecutor) return;

  await disputeExecutor.processPending();
  const evidenceBatch = drainEvidenceBatch(isV2Evidence);
  await disputeExecutor.processEvidenceBatch(evidenceBatch);
}

function drainEvidenceBatch(predicate: (evidence: SlashEvidence) => boolean): SlashEvidence[] {
  const batch: SlashEvidence[] = [];
  for (const store of evidenceStores) {
    batch.push(...store.drainFiltered(predicate));
  }
  return batch;
}

function isV2Evidence(evidence: SlashEvidence): boolean {
  return evidence.rawEvidence?.protocolVersion === 2;
}

// --- BFT Equivocation Polling ---
const l2Rpc = config.l2RpcUrl ?? l1Rpc;
const l2Provider = l2Rpc !== l1Rpc ? new JsonRpcProvider(l2Rpc) : provider;
let lastBftEquivocationPoll = 0;

/**
 * Poll the L2 node for BFT equivocation events and bridge them into the
 * PoSe slash pipeline. Uses the node's evidence store files as the primary
 * source, falling back to RPC if an endpoint exists.
 */
async function tryPollBftEquivocations(): Promise<void> {
  try {
    const res = await l2Provider.send("coc_getEquivocations", [lastBftEquivocationPoll]);
    if (!Array.isArray(res) || res.length === 0) return;

    for (const ev of res) {
      const normalized = normalizeEquivocationRpcEntry(ev as Record<string, unknown>);
      if (!normalized) continue;
      bridgeBftSlash(normalized);
    }
    lastBftEquivocationPoll = Date.now();
    log.info("polled BFT equivocations", { count: res.length });
  } catch {
    // RPC endpoint not available — evidence files are the fallback path
  }
}

export function bridgeBftSlash(evidence: EquivocationEvidence): void {
  const slashEvidence: SlashEvidence = buildBftEquivocationSlashEvidence(evidence);
  // Push into evidence stores for the next tryDisputeV2 cycle
  for (const store of evidenceStores) {
    store.push(slashEvidence);
    break; // Add to first store only
  }
  log.info("bridged BFT equivocation to PoSe slash pipeline", {
    validator: evidence.validatorId,
    height: evidence.height.toString(),
  });
}

setInterval(() => void tick(), intervalMs);
void tick();
