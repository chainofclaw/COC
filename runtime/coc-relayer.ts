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

const log = createLogger("coc-relayer");

const config = await loadConfig();
const intervalMs = Number(process.env.COC_RELAYER_INTERVAL_MS || config.relayerIntervalMs || 60000);
const l1Rpc = process.env.COC_L1_RPC_URL || config.l1RpcUrl || "http://127.0.0.1:8545";
const poseManagerAddress = process.env.COC_POSE_MANAGER || config.poseManagerAddress;
const slasherPk = process.env.COC_SLASHER_PK || config.slasherPrivateKey || config.operatorPrivateKey;

const provider = new JsonRpcProvider(l1Rpc);
if (slasherPk && !/^(0x)?[0-9a-fA-F]{64}$/.test(slasherPk)) {
  log.warn("COC_SLASHER_PK does not look like a valid 32-byte hex private key");
}
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

// Shared evidence store — persistent across restarts
const evidencePath = process.env.COC_EVIDENCE_PATH || (config.dataDir ? `${config.dataDir}/evidence-agent.jsonl` : undefined);
export const evidenceStore = new EvidenceStore(1000, evidencePath);
const pendingChallengeStore = new PendingChallengeStore(pendingChallengesPath);
const disputeExecutor = poseV2Contract && signer
  ? new PoseV2DisputeExecutor({
      contract: poseV2Contract,
      provider,
      signer,
      challengeBondWei,
      store: pendingChallengeStore,
      logger: log,
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

  const tx = await pose.finalizeEpoch(BigInt(candidate));
  const receipt = await tx.wait();
  lastFinalizeEpoch = candidate;

  log.info("finalized", {
    epochId: candidate,
    txHash: tx.hash,
    status: receipt?.status,
    batches: batchIds.length,
  });

  // Distribute rewards after successful finalization (placeholder: equal split)
  try {
    await tryDistributeRewards(candidate, batchIds);
  } catch (error) {
    log.warn("reward distribution failed (non-fatal)", { epochId: candidate, error: String(error) });
  }
}

async function tryDistributeRewards(epochId: number, batchIds: string[]): Promise<void> {
  if (!pose) return;

  const poolBalance: bigint = await pose.rewardPoolBalance();
  if (poolBalance === 0n) {
    log.info("reward pool empty, skipping distribution", { epochId });
    return;
  }

  // Collect unique active aggregators from finalized batches
  const nodeIds = new Set<string>();
  for (const batchId of batchIds) {
    try {
      const batch = await pose.getBatch(batchId);
      if (batch.finalized && !batch.disputed) {
        // Use aggregator address as node identifier placeholder
        const aggregator = batch.aggregator as string;
        if (aggregator && aggregator !== "0x" + "0".repeat(40)) {
          nodeIds.add(aggregator);
        }
      }
    } catch {
      // skip unreadable batches
    }
  }

  if (nodeIds.size === 0) return;

  // Equal split among participating aggregators (placeholder for scoring.ts integration)
  const perNode = poolBalance / BigInt(nodeIds.size);
  if (perNode === 0n) return;

  const rewards = [...nodeIds].map((addr) => ({
    nodeId: "0x" + addr.replace(/^0x/, "").padStart(64, "0"),
    amount: perNode,
  }));

  const rewardTx = await pose.distributeRewards(BigInt(epochId), rewards);
  const rewardReceipt = await rewardTx.wait();
  log.info("rewards distributed", {
    epochId,
    nodes: rewards.length,
    perNode: perNode.toString(),
    txHash: rewardTx.hash,
    status: rewardReceipt?.status,
  });
}

async function tryDispute(): Promise<void> {
  if (!pose) {
    return;
  }

  const evidenceBatch = evidenceStore.drain();
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

async function submitSlash(evidence: SlashEvidence): Promise<void> {
  if (!pose) {
    return;
  }

  // Encode structured header: challengeId (32 bytes) + nodeId (32 bytes) + JSON tail
  const challengeId = typeof evidence.rawEvidence === "object" && evidence.rawEvidence !== null
    ? String((evidence.rawEvidence as Record<string, unknown>).challengeId ?? "0x" + "0".repeat(64))
    : "0x" + "0".repeat(64);
  const challengeIdBytes = Buffer.from(challengeId.replace(/^0x/, "").padStart(64, "0"), "hex");
  const nodeIdBytes = Buffer.from(evidence.nodeId.replace(/^0x/, "").padStart(64, "0"), "hex");
  const jsonTail = Buffer.from(JSON.stringify(evidence.rawEvidence), "utf8");
  const rawBytes = Buffer.concat([challengeIdBytes, nodeIdBytes, jsonTail]);
  const tx = await pose.slash(evidence.nodeId, {
    nodeId: evidence.nodeId,
    reasonCode: evidence.reasonCode,
    evidenceHash: evidence.evidenceHash,
    rawEvidence: rawBytes,
  });
  const receipt = await tx.wait();

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
    const existing: bigint = await poseV2Contract.challengeNonces(BigInt(currentEpoch));
    if (existing !== 0n) {
      lastNonceInitEpoch = currentEpoch;
      return;
    }

    const tx = await poseV2Contract.initEpochNonce(BigInt(currentEpoch));
    await tx.wait();
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

    const tx = await poseV2Contract.finalizeEpochV2(
      BigInt(candidate),
      rewardRoot,
      totalReward,
      slashTotal,
      treasuryDelta,
    );
    const receipt = await tx.wait();
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
  const evidenceBatch = evidenceStore.drain();
  await disputeExecutor.processEvidenceBatch(evidenceBatch);
}

setInterval(() => void tick(), intervalMs);
void tick();
