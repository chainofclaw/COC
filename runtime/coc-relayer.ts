import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { EvidenceStore } from "./lib/evidence-store.ts";
import type { SlashEvidence } from "../services/verifier/anti-cheat-policy.ts";
import { createLogger } from "../node/src/logger.ts";

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
  "function challengeBatch(bytes32 batchId, bytes32 receiptLeaf, bytes32[] merkleProof)",
  "function slash(bytes32 nodeId, tuple(bytes32 nodeId, uint8 reasonCode, bytes32 evidenceHash, bytes rawEvidence) evidence)",
];

const pose = poseManagerAddress && signer ? new Contract(poseManagerAddress, poseAbi, signer) : null;
let lastFinalizeEpoch = 0;

// Shared evidence store — persistent across restarts
const evidencePath = process.env.COC_EVIDENCE_PATH || (config.dataDir ? `${config.dataDir}/evidence-relayer.jsonl` : undefined);
export const evidenceStore = new EvidenceStore(1000, evidencePath);

async function tick(): Promise<void> {
  try {
    await tryFinalize();
    await tryDispute();
    log.info("tick ok");
  } catch (error) {
    log.error("tick failed", { error: String(error) });
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

  const rawBytes = Buffer.from(JSON.stringify(evidence.rawEvidence), "utf8");
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

setInterval(() => void tick(), intervalMs);
void tick();
