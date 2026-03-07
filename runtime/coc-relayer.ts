import { join } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { EvidenceStore } from "./lib/evidence-store.ts";
import { PendingChallengeStore } from "./lib/pending-challenge-store.ts";
import { PoseV2DisputeExecutor } from "./lib/pose-v2-dispute-executor.ts";
import { readRewardManifest } from "./lib/reward-manifest.ts";
import type { SlashEvidence } from "../services/verifier/anti-cheat-policy.ts";
import { createLogger } from "../node/src/logger.ts";
import { ContractReader } from "./lib/contract-reader.ts";
import { encodeSlashEvidencePayload, resolveEvidencePaths } from "../services/common/slash-evidence.ts";
import { resolvePrivateKey } from "./lib/key-material.ts";
import { retryAsync } from "./lib/retry.ts";

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
  retries: Math.max(0, Number(process.env.COC_TX_RETRY_ATTEMPTS || config.txRetryAttempts ?? 2)),
  baseDelayMs: Math.max(1, Number(process.env.COC_TX_RETRY_BASE_DELAY_MS || config.txRetryBaseDelayMs ?? 250)),
  maxDelayMs: Math.max(1, Number(process.env.COC_TX_RETRY_MAX_DELAY_MS || config.txRetryMaxDelayMs ?? 5000)),
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
      await tryDispute();
      await tryDisputeV2();
    } else {
      await tryFinalize();
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

  const currentEpoch = Math.floor(Date.now() / (60 * 60 * 1000));
  const candidate = currentEpoch - 3;
  if (candidate <= 0 || candidate <= lastFinalizeEpoch) {
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

async function tryDistributeRewards(epochId: number, _batchIds: string[]): Promise<void> {
  if (!pose) return;

  const manifest = readRewardManifest(rewardManifestDir, epochId);
  if (!manifest || manifest.leaves.length === 0) {
    log.warn("v1 reward manifest not found or empty, skipping distribution", { epochId });
    return;
  }

  const poolBalance: bigint = await retryAsync(() => pose.rewardPoolBalance() as Promise<bigint>, txRetryOptions);
  if (poolBalance === 0n) {
    log.info("reward pool empty, skipping distribution", { epochId });
    return;
  }

  const manifestTotal = BigInt(manifest.totalReward);
  const effectivePool = poolBalance < manifestTotal ? poolBalance : manifestTotal;

  const rewards = manifest.leaves.map((leaf) => {
    const rawAmount = BigInt(leaf.amount);
    const scaled = manifestTotal > 0n ? (rawAmount * effectivePool) / manifestTotal : 0n;
    return {
      nodeId: leaf.nodeId.length === 42
        ? "0x" + leaf.nodeId.replace(/^0x/, "").padStart(64, "0")
        : leaf.nodeId,
      amount: scaled,
    };
  }).filter((r) => r.amount > 0n);

  if (rewards.length === 0) return;

  const rewardTx = await retryAsync(() => pose.distributeRewards(BigInt(epochId), rewards), txRetryOptions);
  const rewardReceipt = await retryAsync(() => rewardTx.wait(), txRetryOptions);
  log.info("rewards distributed (scoring model)", {
    epochId,
    nodes: rewards.length,
    pool: poolBalance.toString(),
    manifestTotal: manifestTotal.toString(),
    txHash: rewardTx.hash,
    status: rewardReceipt?.status,
  });
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

  const currentEpoch = Math.floor(Date.now() / (60 * 60 * 1000));
  const candidate = currentEpoch - 3;
  if (candidate <= 0 || candidate <= lastFinalizeEpoch) return;

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

    if (batchIds.length > 0) {
      // Read authoritative reward manifest produced by agent
      const manifest = readRewardManifest(rewardManifestDir, candidate);
      if (!manifest) {
        log.warn("finalizeV2 skipped: non-empty epoch but reward manifest not found", {
          epochId: candidate,
          batches: batchIds.length,
          manifestDir: rewardManifestDir,
        });
        return;
      }
      rewardRoot = manifest.rewardRoot;
      totalReward = BigInt(manifest.totalReward);
      slashTotal = BigInt(manifest.slashTotal);
      treasuryDelta = BigInt(manifest.treasuryDelta);
      log.info("reward manifest loaded", {
        epochId: candidate,
        rewardRoot,
        totalReward: totalReward.toString(),
        leaves: manifest.leaves.length,
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

setInterval(() => void tick(), intervalMs);
void tick();
