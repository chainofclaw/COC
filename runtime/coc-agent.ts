import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { requestJson } from "./lib/http-client.ts";
import { EvidenceStore } from "./lib/evidence-store.ts";
import { ChallengeFactory, buildChallengeVerifyPayload } from "../services/challenger/challenge-factory.ts";
import { ChallengeFactoryV2 } from "../services/challenger/challenge-factory-v2.ts";
import { ChallengeQuota } from "../services/challenger/challenge-quota.ts";
import { ReceiptVerifier } from "../services/verifier/receipt-verifier.ts";
import { NonceRegistry } from "../services/verifier/nonce-registry.ts";
import { BatchAggregator } from "../services/aggregator/batch-aggregator.ts";
import { BatchAggregatorV2 } from "../services/aggregator/batch-aggregator-v2.ts";
import { computeEpochRewards } from "../services/verifier/scoring.ts";
import { buildRewardRoot } from "../services/common/reward-tree.ts";
import { AntiCheatPolicy, EvidenceReason } from "../services/verifier/anti-cheat-policy.ts";
import { keccak256Hex } from "../services/relayer/keccak256.ts";
import { ChallengeType } from "../services/common/pose-types.ts";
import type { ChallengeMessageV2, VerifiedReceiptV2 } from "../services/common/pose-types-v2.ts";
import { ResultCode } from "../services/common/pose-types-v2.ts";
import { hashPair } from "../node/src/ipfs-merkle.ts";
import type { UnixFsFileMeta, Hex } from "../node/src/ipfs-types.ts";
import { createLogger } from "../node/src/logger.ts";
import { createNodeSigner, createNodeSignerV2, buildReceiptSignMessage } from "../node/src/crypto/signer.ts";
import { buildDomain, CHALLENGE_TYPES, RECEIPT_TYPES } from "../node/src/crypto/eip712-types.ts";
import { buildSignedPosePayload } from "../node/src/pose-http.ts";
import { collectBatchWitnessSignatures, collectWitnesses } from "./lib/witness-collector.ts";
import { ContractReader } from "./lib/contract-reader.ts";
import { extractPendingV1Epoch, extractPendingV2Epoch, pruneStoreByEpoch } from "./lib/pending-retention.ts";

const log = createLogger("coc-agent");

const config = await loadConfig();
const nodeUrl = process.env.COC_NODE_URL || config.nodeUrl || "http://127.0.0.1:18780";
const intervalMs = normalizeInt(process.env.COC_AGENT_INTERVAL_MS || config.agentIntervalMs, 60000);
const batchSize = normalizeInt(process.env.COC_AGENT_BATCH_SIZE || config.agentBatchSize, 5);
const sampleSize = normalizeInt(process.env.COC_AGENT_SAMPLE_SIZE || config.agentSampleSize, 2);
const storageDir = resolveStorageDir(config.dataDir, config.storageDir);
const nonceRegistryPath = process.env.COC_NONCE_REGISTRY_PATH || config.nonceRegistryPath || join(config.dataDir, "nonce-registry.log");
const nonceRegistryTtlMs = normalizeInt(
  process.env.COC_NONCE_REGISTRY_TTL_MS || config.nonceRegistryTtlMs,
  7 * 24 * 60 * 60 * 1000,
);
const nonceRegistryMaxEntries = normalizeInt(
  process.env.COC_NONCE_REGISTRY_MAX_ENTRIES || config.nonceRegistryMaxEntries,
  500_000,
);
const endpointFingerprintMode = resolveEndpointFingerprintMode(
  process.env.COC_ENDPOINT_FINGERPRINT_MODE || config.endpointFingerprintMode,
);

const l1RpcUrl = process.env.COC_L1_RPC_URL || config.l1RpcUrl || "http://127.0.0.1:8545";
const poseManagerAddress = process.env.COC_POSE_MANAGER || config.poseManagerAddress;
const operatorPrivateKey = process.env.COC_OPERATOR_PK || config.operatorPrivateKey;
if (!operatorPrivateKey) {
  throw new Error("missing operator private key: set COC_OPERATOR_PK or config.operatorPrivateKey");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(operatorPrivateKey)) {
  throw new Error("invalid operator private key format: expected 32-byte hex string with 0x prefix");
}

const provider = new JsonRpcProvider(l1RpcUrl);
const signer = new Wallet(operatorPrivateKey, provider);
const agentSigner = createNodeSigner(operatorPrivateKey);
const challengerSet = (config.challengerSet ?? []).map((x) => x.toLowerCase());
const aggregatorSet = (config.aggregatorSet ?? []).map((x) => x.toLowerCase());

// Machine fingerprint: hostname + primary MAC + operator pubkey
// Same physical machine always produces the same commitment regardless of port
function computeMachineFingerprint(pubkey: string): string {
  const host = hostname();
  const ifaces = networkInterfaces();
  let mac = "00:00:00:00:00:00";
  for (const name of Object.keys(ifaces).sort()) {
    const entries = ifaces[name] ?? [];
    const found = entries.find((e) => !e.internal && e.mac !== "00:00:00:00:00:00");
    if (found) {
      mac = found.mac;
      break;
    }
  }
  if (endpointFingerprintMode === "legacy") {
    // Legacy mode keeps pubkey in fingerprint; retained only for migration.
    return `machine:${host}:${mac}:${pubkey}`;
  }
  // Strict mode binds endpoint commitment to machine identity only.
  return `machine:${host}:${mac}`;
}

function addressToHex32(address: string): `0x${string}` {
  const clean = address.startsWith("0x") ? address.slice(2) : address;
  return `0x${clean.padStart(64, "0")}` as `0x${string}`;
}

function hex32ToAddress(hex32: string): string {
  const clean = hex32.startsWith("0x") ? hex32.slice(2) : hex32;
  return `0x${clean.slice(-40)}`.toLowerCase();
}

const poseAbi = [
  "function registerNode(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, bytes32 metadataHash, bytes ownershipSig, bytes endpointAttestation) payable",
  "function updateCommitment(bytes32 nodeId, bytes32 newCommitment)",
  "function getNode(bytes32 nodeId) view returns (tuple(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, uint256 bondAmount, bytes32 metadataHash, uint64 registeredAtEpoch, uint64 unlockEpoch, bool active))",
  "function submitBatch(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, tuple(bytes32 leaf, bytes32[] merkleProof, uint32 leafIndex)[] sampleProofs) returns (bytes32 batchId)",
  "function operatorNodeCount(address) view returns (uint8)",
  "function requiredBond(address) view returns (uint256)",
];

const MIN_BOND_WEI = BigInt(process.env.COC_MIN_BOND_WEI || config.minBondWei || "100000000000000000"); // 0.1 ETH

const poseContract = poseManagerAddress ? new Contract(poseManagerAddress, poseAbi, signer) : null;

// --- v2 Protocol Setup ---
const useV2 = config.protocolVersion === 2;
const v2ChainId = config.chainId ?? 20241224;
const v2VerifyingContract = config.verifyingContract ?? config.poseManagerV2Address ?? "0x0000000000000000000000000000000000000000";
if (useV2 && (!config.poseManagerV2Address || !config.verifyingContract)) {
  throw new Error("v2 protocol requires both poseManagerV2Address and verifyingContract in config");
}
const v2Domain = buildDomain(BigInt(v2ChainId), v2VerifyingContract);
const agentSignerV2 = useV2 ? createNodeSignerV2(operatorPrivateKey, v2Domain) : null;

const factoryV2 = useV2 && agentSignerV2 ? new ChallengeFactoryV2({
  challengerId: addressToHex32(agentSigner.nodeId),
  eip712Signer: agentSignerV2.eip712,
}) : null;

const aggregatorV2 = useV2 ? new BatchAggregatorV2({ sampleSize }) : null;
const contractReader = useV2 ? new ContractReader({
  l2RpcUrl: config.l2RpcUrl ?? "http://127.0.0.1:18780",
  poseManagerV2Address: config.poseManagerV2Address,
}) : null;

const v2WitnessNodes = config.witnessNodes ?? [];
const v2RequiredWitnesses = config.requiredWitnesses ?? 0;
const allowEmptyBatchWitnessSubmission = config.allowEmptyBatchWitnessSubmission ?? true;
const v2TipTolerance = config.tipToleranceBlocks ?? 10;

const poseV2Abi = [
  "function initEpochNonce(uint64 epochId)",
  "function submitBatchV2(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, tuple(bytes32 leaf, bytes32[] merkleProof, uint32 leafIndex)[] sampleProofs, uint32 witnessBitmap, bytes[] witnessSignatures) returns (bytes32 batchId)",
  "function getActiveNodeCount() view returns (uint256)",
  "function getWitnessSet(uint64 epochId) view returns (bytes32[])",
  "function challengeNonces(uint64 epochId) view returns (uint64)",
  "function registerNode(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, bytes32 metadataHash, bytes ownershipSig, bytes endpointAttestation) payable",
  "function getNode(bytes32 nodeId) view returns (tuple(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, uint256 bondAmount, bytes32 metadataHash, uint64 registeredAtEpoch, uint64 unlockEpoch, bool active))",
  "function operatorNodeCount(address) view returns (uint8)",
];

const poseV2Address = config.poseManagerV2Address;
const poseV2Contract = poseV2Address && signer ? new Contract(poseV2Address, poseV2Abi, signer) : null;

const factory = new ChallengeFactory({
  challengerId: addressToHex32(agentSigner.nodeId),
  sign: (digest) => agentSigner.sign(digest) as `0x${string}`,
});

const quota = new ChallengeQuota({
  maxPerEpoch: { U: 6, S: 2, R: 2 },
  minIntervalMs: { U: 1000, S: 2000, R: 2000 },
});

const verifier = new ReceiptVerifier({
  nonceRegistry: new NonceRegistry({
    persistencePath: nonceRegistryPath,
    ttlMs: nonceRegistryTtlMs,
    maxEntries: nonceRegistryMaxEntries,
  }),
  verifyChallengerSig: (challenge) => {
    const payload = buildChallengeVerifyPayload(challenge);
    const challengerAddr = hex32ToAddress(challenge.challengerId);
    return agentSigner.verifyNodeSig(payload, challenge.challengerSig, challengerAddr);
  },
  verifyNodeSig: (_challenge, receipt, responseBodyHash) => {
    const msg = buildReceiptSignMessage(
      receipt.challengeId,
      receipt.nodeId,
      responseBodyHash,
      receipt.responseAtMs,
    );
    const nodeAddr = hex32ToAddress(receipt.nodeId);
    return agentSigner.verifyNodeSig(msg, receipt.nodeSig, nodeAddr);
  },
  verifyUptimeResult: (challenge, receipt) => {
    if (!receipt.responseBody?.ok) return false;
    const bn = Number(receipt.responseBody?.blockNumber);
    if (!Number.isFinite(bn) || bn <= 0) return false;
    // Verify blockNumber is within expected range from challenge querySpec
    const minBn = Number((challenge.querySpec as any)?.minBlockNumber ?? 0);
    if (minBn > 0 && bn < minBn) return false;
    // Validate blockHash format if present (phase-in: missing is accepted with warning)
    const blockHash = receipt.responseBody?.blockHash;
    if (blockHash !== undefined && blockHash !== null) {
      if (typeof blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
        log.warn("uptime receipt has malformed blockHash, rejecting", { blockHash });
        return false;
      }
    } else {
      log.warn("uptime receipt missing blockHash (phase-in period, accepting)", {
        nodeId: receipt.nodeId,
        challengeId: challenge.challengeId,
      });
    }
    return true;
  },
  verifyStorageProof: (challenge, receipt) => {
    const hash = receipt.responseBody?.chunkDataHash ?? receipt.responseBody?.leafHash;
    const path = receipt.responseBody?.merklePath;
    const root = receipt.responseBody?.merkleRoot;
    const chunkIndex = Number(receipt.responseBody?.chunkIndex ?? 0);
    if (typeof hash !== "string" || !hash.startsWith("0x")) return false;
    if (typeof root !== "string" || !root.startsWith("0x")) return false;
    if (!Array.isArray(path)) return false;
    const expectedRoot = (challenge.querySpec as any)?.merkleRoot;
    if (expectedRoot && expectedRoot !== root) return false;
    const computed = computeMerkleRoot(hash as Hex, path as Hex[], chunkIndex);
    return computed === root;
  },
  verifyRelayResult: (_challenge, receipt) => {
    if (!receipt.responseBody?.ok) return false;
    const witness = receipt.responseBody?.witness as Record<string, unknown> | undefined;
    if (!witness || typeof witness !== "object") return false;

    const routeTag = typeof witness.routeTag === "string" ? witness.routeTag : "";
    const challengeId = typeof witness.challengeId === "string" ? witness.challengeId : "";
    const relayer = typeof witness.relayer === "string" ? witness.relayer.toLowerCase() : "";
    const signature = typeof witness.signature === "string" ? witness.signature : "";
    const witnessResponseAtMs = witness.responseAtMs;
    if (!routeTag || !challengeId || !relayer || !signature || witnessResponseAtMs === undefined) return false;

    if (challengeId !== _challenge.challengeId) return false;
    const expectedRouteTag = String((_challenge.querySpec as Record<string, unknown>)?.routeTag ?? "");
    if (expectedRouteTag && routeTag !== expectedRouteTag) return false;

    const receiptNodeAddr = hex32ToAddress(receipt.nodeId);
    if (relayer !== receiptNodeAddr) return false;

    let responseAtMs: bigint;
    try {
      responseAtMs = BigInt(String(witnessResponseAtMs));
    } catch {
      return false;
    }
    if (responseAtMs !== receipt.responseAtMs) return false;

    // Verify relay timing: response must be within reasonable window of challenge issuance
    const challengeIssuedMs = Number(_challenge.issuedAtMs);
    const responseMs = Number(responseAtMs);
    const maxRelayLatencyMs = 300_000; // 5 minutes max relay latency
    if (responseMs < challengeIssuedMs || responseMs - challengeIssuedMs > maxRelayLatencyMs) return false;

    // Verify witness txHash exists on-chain (if provided)
    const witnessTxHash = typeof witness.txHash === "string" ? witness.txHash : "";
    if (witnessTxHash && !/^0x[0-9a-fA-F]{64}$/.test(witnessTxHash)) return false;

    const relayMsg = `pose:relay:${_challenge.challengeId}:${routeTag}:${responseAtMs.toString()}`;
    return agentSigner.verifyNodeSig(relayMsg, signature, relayer);
  },
});

const aggregator = new BatchAggregator({
  sampleSize,
  signSummary: (s) => `0x${keccak256Hex(Buffer.from(s.slice(2), "hex"))}`,
});

const trackedNodeIds = normalizeNodeIds(config.nodeIds);
const nodeEndpointMap = normalizeNodeEndpointMap(config.nodeEndpoints);
const nodeScores = new Map<string, { uptimeOk: number; uptimeTotal: number; storageOk: number; storageTotal: number; relayOk: number; relayTotal: number; verifiedStorageBytes: number }>();

function serializeWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") {
      return { __coc_bigint__: v.toString() };
    }
    return v;
  });
}

function deserializeWithBigInt<T>(line: string): T {
  return JSON.parse(line, (_key, v) => {
    if (
      v &&
      typeof v === "object" &&
      "__coc_bigint__" in v &&
      typeof (v as { __coc_bigint__?: unknown }).__coc_bigint__ === "string"
    ) {
      return BigInt((v as { __coc_bigint__: string }).__coc_bigint__);
    }
    return v;
  }) as T;
}

// Persistent pending receipts store — survives crash/restart
class PendingReceiptStore<T> {
  private items: T[] = [];
  private readonly path: string;
  private readonly label: string;

  constructor(persistencePath: string, label: string) {
    this.path = persistencePath;
    this.label = label;
    this.loadFromDisk();
  }

  get length(): number { return this.items.length; }

  push(item: T): void {
    this.items.push(item);
    this.appendToDisk(item);
  }

  extend(items: T[]): void {
    if (items.length === 0) return;
    this.items.push(...items);
    this.rewriteDisk();
  }

  drain(): T[] {
    const result = this.items.splice(0);
    this.rewriteDisk();
    return result;
  }

  listWhere(predicate: (item: T) => boolean): T[] {
    return this.items.filter(predicate);
  }

  countWhere(predicate: (item: T) => boolean): number {
    let count = 0;
    for (const item of this.items) {
      if (predicate(item)) count += 1;
    }
    return count;
  }

  extractWhere(predicate: (item: T) => boolean): T[] {
    const kept: T[] = [];
    const extracted: T[] = [];
    for (const item of this.items) {
      if (predicate(item)) {
        extracted.push(item);
      } else {
        kept.push(item);
      }
    }
    if (extracted.length > 0) {
      this.items = kept;
      this.rewriteDisk();
    }
    return extracted;
  }

  removeWhere(predicate: (item: T) => boolean): number {
    return this.extractWhere(predicate).length;
  }

  private appendToDisk(item: T): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, serializeWithBigInt(item) + "\n");
    } catch { /* best-effort */ }
  }

  private rewriteDisk(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (this.items.length === 0) {
        writeFileSync(this.path, "");
        return;
      }
      const content = this.items.map((item) => serializeWithBigInt(item)).join("\n") + "\n";
      writeFileSync(this.path, content);
    } catch { /* best-effort */ }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf-8");
      for (const line of raw.split("\n").filter((l) => l.trim())) {
        try { this.items.push(deserializeWithBigInt<T>(line)); } catch { /* skip */ }
      }
      if (this.items.length > 0) {
        log.info("restored pending receipts from disk", { label: this.label, count: this.items.length, path: this.path });
      }
    } catch { /* ignore */ }
  }
}

const pendingPath = process.env.COC_PENDING_PATH || config.pendingPath || join(config.dataDir, "pending-receipts.jsonl");
const pendingV2Path = process.env.COC_PENDING_V2_PATH || config.pendingV2Path || join(config.dataDir, "pending-receipts-v2.jsonl");
const pendingRetentionEpochs = normalizeNonNegativeInt(
  process.env.COC_PENDING_RETENTION_EPOCHS || config.pendingRetentionEpochs,
  72,
);
const pendingArchivePath = process.env.COC_PENDING_ARCHIVE_PATH || config.pendingArchivePath || join(config.dataDir, "pending-receipts-archive.jsonl");
const pendingV2ArchivePath = process.env.COC_PENDING_V2_ARCHIVE_PATH || config.pendingV2ArchivePath || join(config.dataDir, "pending-receipts-v2-archive.jsonl");
const pending = new PendingReceiptStore<any>(pendingPath, "v1");
const pendingV2 = new PendingReceiptStore<VerifiedReceiptV2>(pendingV2Path, "v2");
const runtimeStats = {
  pruneRemovedV1: 0,
  pruneRemovedV2: 0,
  pruneArchiveFailedV1: 0,
  pruneArchiveFailedV2: 0,
  roleMismatchV1: 0,
  roleMismatchV2: 0,
};
let currentEpoch = currentEpochId();
log.info("endpoint fingerprint mode", { mode: endpointFingerprintMode });

if (useV2 && trackedNodeIds.length > 1) {
  const missing = trackedNodeIds.filter((id) => !nodeEndpointMap.has(id.toLowerCase()));
  if (missing.length > 0) {
    log.warn("v2 mode: missing nodeEndpoints mapping for tracked nodes; these nodes will be skipped", { missing });
  }
}

// Evidence pipeline: agent writes, relayer consumes
const evidencePath = process.env.COC_EVIDENCE_PATH || join(config.dataDir, "evidence-agent.jsonl");
export const evidenceStore = new EvidenceStore(1000, evidencePath);
const antiCheat = new AntiCheatPolicy();

await ensureNodeRegistered();

function appendPendingArchive(
  protocol: "v1" | "v2",
  path: string,
  cutoffEpoch: number,
  items: unknown[],
): boolean {
  if (items.length === 0) return true;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const archivedAtMs = Date.now();
    const content = items
      .map((item) => serializeWithBigInt({
        protocol,
        archivedAtMs,
        cutoffEpoch,
        item,
      }))
      .join("\n") + "\n";
    appendFileSync(path, content);
    return true;
  } catch (error) {
    log.error("pending archive write failed", {
      protocol,
      path,
      count: items.length,
      error: String(error),
    });
    return false;
  }
}

function pruneStalePending(nowEpoch: number): void {
  const v1 = pruneStoreByEpoch({
    nowEpoch,
    retentionEpochs: pendingRetentionEpochs,
    store: pending,
    extractEpoch: extractPendingV1Epoch,
    archive: (items, cutoffEpoch) => appendPendingArchive("v1", pendingArchivePath, cutoffEpoch, items),
  });
  if (v1.staleCount > 0 && v1.cutoffEpoch !== null) {
    if (v1.archived) {
      runtimeStats.pruneRemovedV1 += v1.removedCount;
      log.warn("pruned stale pending receipts", {
        protocol: "v1",
        count: v1.removedCount,
        cutoffEpoch: v1.cutoffEpoch,
        archivePath: pendingArchivePath,
      });
    } else {
      runtimeStats.pruneArchiveFailedV1 += 1;
      log.error("pending prune skipped: archive write failed", {
        protocol: "v1",
        count: v1.staleCount,
        cutoffEpoch: v1.cutoffEpoch,
        archivePath: pendingArchivePath,
      });
    }
  }

  const v2 = pruneStoreByEpoch({
    nowEpoch,
    retentionEpochs: pendingRetentionEpochs,
    store: pendingV2,
    extractEpoch: extractPendingV2Epoch,
    archive: (items, cutoffEpoch) => appendPendingArchive("v2", pendingV2ArchivePath, cutoffEpoch, items),
  });
  if (v2.staleCount > 0 && v2.cutoffEpoch !== null) {
    if (v2.archived) {
      runtimeStats.pruneRemovedV2 += v2.removedCount;
      log.warn("pruned stale pending receipts", {
        protocol: "v2",
        count: v2.removedCount,
        cutoffEpoch: v2.cutoffEpoch,
        archivePath: pendingV2ArchivePath,
      });
    } else {
      runtimeStats.pruneArchiveFailedV2 += 1;
      log.error("pending prune skipped: archive write failed", {
        protocol: "v2",
        count: v2.staleCount,
        cutoffEpoch: v2.cutoffEpoch,
        archivePath: pendingV2ArchivePath,
      });
    }
  }
}

function countPendingV2ByEpoch(epochId: number): number {
  return pendingV2.countWhere((item) => extractPendingV2Epoch(item) === epochId);
}

function listPendingV2ByEpoch(epochId: number): VerifiedReceiptV2[] {
  return pendingV2.listWhere((item) => extractPendingV2Epoch(item) === epochId);
}

function removePendingV2ByEpoch(epochId: number): number {
  return pendingV2.removeWhere((item) => extractPendingV2Epoch(item) === epochId);
}

async function tick(): Promise<void> {
  try {
    await refreshLatestBlock();
    await refreshSelfNodeStatus();
    const nowEpoch = currentEpochId();
    pruneStalePending(nowEpoch);

    if (useV2) {
      // v2 path
      if (nowEpoch !== currentEpoch) {
        const rolloverReceipts = listPendingV2ByEpoch(currentEpoch);
        if (rolloverReceipts.length > 0) {
          const ok = await flushBatchV2(currentEpoch, rolloverReceipts);
          if (!ok) {
            if (poseV2Contract && canRunAggregatorRole(currentEpoch)) {
              log.warn("v2 epoch rollover deferred: pending batch flush failed", {
                epochId: currentEpoch,
                pending: rolloverReceipts.length,
              });
              return;
            }
            log.error("v2 rollover batch not flushed: no aggregator permission for epoch, pending retained", {
              epochId: currentEpoch,
              pending: rolloverReceipts.length,
            });
          } else {
            removePendingV2ByEpoch(currentEpoch);
          }
        }
        emitEpochScores(currentEpoch);
        nodeScores.clear();
        currentEpoch = nowEpoch;
      }

      const canChallengeNow = canRunForEpochRole(currentEpoch);
      const canAggregateNow = canRunAggregatorRole(currentEpoch);
      if (poseV2Contract && canChallengeNow && !canAggregateNow) {
        runtimeStats.roleMismatchV2 += 1;
        log.error("v2 role mismatch: challenger enabled but aggregator disabled, skip challenges to avoid unflushable receipts", {
          epochId: currentEpoch,
          address: signer.address.toLowerCase(),
        });
        return;
      }
      if (!canChallengeNow) return;

      for (const nodeId of trackedNodeIds) {
        await tryChallengeV2(nodeId, "Uptime");
        await tryChallengeV2(nodeId, "Storage");
        await tryChallengeV2(nodeId, "Relay");
      }

      if (countPendingV2ByEpoch(currentEpoch) >= batchSize) {
        const currentEpochReceipts = listPendingV2ByEpoch(currentEpoch);
        const ok = await flushBatchV2(currentEpoch, currentEpochReceipts);
        if (ok) {
          removePendingV2ByEpoch(currentEpoch);
        } else {
          if (poseV2Contract && canRunAggregatorRole(currentEpoch)) {
            log.warn("v2 batch flush failed; receipts retained for retry", {
              epochId: currentEpoch,
              pending: currentEpochReceipts.length,
            });
          } else {
            log.error("v2 batch not flushed: no aggregator permission for epoch, receipts retained", {
              epochId: currentEpoch,
              pending: currentEpochReceipts.length,
            });
          }
        }
      }
    } else {
      // v1 path
      if (nowEpoch !== currentEpoch) {
        if (pending.length > 0) {
          const rolloverReceipts = pending.drain();
          const ok = await flushBatch(currentEpoch, rolloverReceipts);
          if (!ok) {
            pending.extend(rolloverReceipts);
            if (poseContract && canRunAggregatorRole(currentEpoch)) {
              log.warn("v1 epoch rollover deferred: pending batch flush failed", {
                epochId: currentEpoch,
                pending: rolloverReceipts.length,
              });
              return;
            }
            log.error("v1 rollover batch not flushed: no aggregator permission for epoch, pending retained", {
              epochId: currentEpoch,
              pending: rolloverReceipts.length,
            });
          }
        }
        emitEpochScores(currentEpoch);
        nodeScores.clear();
        currentEpoch = nowEpoch;
      }

      const canChallengeNow = canRunForEpochRole(currentEpoch);
      const canAggregateNow = canRunAggregatorRole(currentEpoch);
      if (poseContract && canChallengeNow && !canAggregateNow) {
        runtimeStats.roleMismatchV1 += 1;
        log.error("v1 role mismatch: challenger enabled but aggregator disabled, skip challenges to avoid unflushable receipts", {
          epochId: currentEpoch,
          address: signer.address.toLowerCase(),
        });
        return;
      }
      if (!canChallengeNow) return;

      for (const nodeId of trackedNodeIds) {
        await tryChallenge(nodeId, "Uptime");
        await tryChallenge(nodeId, "Storage");
        await tryChallenge(nodeId, "Relay");
      }

      if (pending.length >= batchSize) {
        const receipts = pending.drain();
        const ok = await flushBatch(currentEpoch, receipts);
        if (!ok) {
          pending.extend(receipts);
          if (poseContract && canRunAggregatorRole(currentEpoch)) {
            log.warn("v1 batch flush failed; receipts retained for retry", {
              epochId: currentEpoch,
              pending: receipts.length,
            });
          } else {
            log.error("v1 batch not flushed: no aggregator permission for epoch, receipts retained", {
              epochId: currentEpoch,
              pending: receipts.length,
            });
          }
        }
      }
    }

    log.info("tick ok", {
      pendingV1: pending.length,
      pendingV2: pendingV2.length,
      pruneRemovedV1: runtimeStats.pruneRemovedV1,
      pruneRemovedV2: runtimeStats.pruneRemovedV2,
      pruneArchiveFailedV1: runtimeStats.pruneArchiveFailedV1,
      pruneArchiveFailedV2: runtimeStats.pruneArchiveFailedV2,
      roleMismatchV1: runtimeStats.roleMismatchV1,
      roleMismatchV2: runtimeStats.roleMismatchV2,
    });
  } catch (error) {
    log.error("tick failed", { error: String(error) });
  }
}

// --- v2 Challenge and Batch ---

async function tryChallengeV2(nodeId: string, kind: keyof typeof ChallengeType): Promise<void> {
  if (!factoryV2 || !contractReader || !agentSignerV2) return;

  const targetUrl = resolveNodeEndpoint(nodeId);
  if (!targetUrl) {
    log.warn("v2 challenge skipped: missing node endpoint mapping", { nodeId });
    return;
  }

  const code = ChallengeType[kind];
  const canIssue = quota.canIssue(nodeId as any, BigInt(currentEpoch), code, BigInt(Date.now()));
  if (!canIssue.ok) return;

  const storageTarget = kind === "Storage" ? await pickStorageTarget(storageDir) : null;
  if (kind === "Storage" && !storageTarget) return;

  let challengeNonce = 0n;
  try {
    challengeNonce = await contractReader.getChallengeNonce(BigInt(currentEpoch));
  } catch { /* use 0 */ }

  const challenge = await factoryV2.issue({
    epochId: BigInt(currentEpoch),
    nodeId: nodeId as any,
    challengeType: kind,
    issuedAtMs: BigInt(Date.now()),
    querySpec: buildQuerySpec(kind, storageTarget),
    challengeNonce,
  });

  quota.commitIssue(nodeId as any, BigInt(currentEpoch), code, BigInt(Date.now()));

  let receiptPayload: any;
  try {
    await requestJson(
      `${targetUrl}/pose/challenge`,
      "POST",
      buildSignedPosePayload("/pose/challenge", challenge as unknown as Record<string, unknown>, agentSigner),
    );
    const receiptResp = await requestJson(
      `${targetUrl}/pose/receipt`,
      "POST",
      buildSignedPosePayload("/pose/receipt", {
        challengeId: challenge.challengeId,
        challengeType: code,
        payload: { nodeId, kind },
      }, agentSigner),
    );
    receiptPayload = receiptResp.json;
  } catch (networkError) {
    log.warn("node unreachable (v2)", { nodeId, kind, error: String(networkError) });
    updateScore(nodeId, kind, false);
    return;
  }

  try {
    const receiptNodeId = typeof receiptPayload.nodeId === "string" ? receiptPayload.nodeId.toLowerCase() : "";
    if (receiptNodeId !== nodeId.toLowerCase()) {
      throw new Error("receipt nodeId mismatch");
    }
    if (typeof receiptPayload.nodeSig !== "string" || !receiptPayload.nodeSig.startsWith("0x")) {
      throw new Error("missing receipt node signature");
    }

    const responseBody =
      receiptPayload.responseBody && typeof receiptPayload.responseBody === "object"
        ? (receiptPayload.responseBody as Record<string, unknown>)
        : {};
    const responseBodyHash = `0x${keccak256Hex(Buffer.from(stableStringifyAgent(responseBody), "utf8"))}`;
    if (receiptPayload.responseBodyHash && String(receiptPayload.responseBodyHash).toLowerCase() !== responseBodyHash.toLowerCase()) {
      throw new Error("response body hash mismatch");
    }

    const responseAtMs = BigInt(receiptPayload.responseAtMs ?? 0);
    if (responseAtMs < challenge.issuedAtMs || responseAtMs > challenge.issuedAtMs + BigInt(challenge.deadlineMs)) {
      throw new Error("receipt deadline violation");
    }

    const challengeTypeNum = code === "U" ? 0 : code === "S" ? 1 : 2;
    const challengeData = {
      challengeId: challenge.challengeId,
      epochId: challenge.epochId,
      nodeId: challenge.nodeId,
      challengeType: challengeTypeNum,
      nonce: challenge.nonce,
      challengeNonce: challenge.challengeNonce,
      querySpecHash: challenge.querySpecHash,
      issuedAtMs: challenge.issuedAtMs,
      deadlineMs: BigInt(challenge.deadlineMs),
      challengerId: challenge.challengerId,
    };
    const challengerAddr = hex32ToAddress(challenge.challengerId);
    if (!agentSignerV2.eip712.verifyTypedData(CHALLENGE_TYPES, challengeData, challenge.challengerSig, challengerAddr)) {
      throw new Error("invalid challenger signature");
    }

    const tipHashRaw = typeof receiptPayload.tipHash === "string" ? receiptPayload.tipHash : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(tipHashRaw)) {
      throw new Error("invalid tipHash");
    }
    const tipHash = tipHashRaw as `0x${string}`;
    const tipHeight = BigInt(receiptPayload.tipHeight ?? 0);
    if (tipHeight < 0n) {
      throw new Error("invalid tipHeight");
    }

    let chainTip: { hash: `0x${string}`; number: bigint } | null = null;
    try {
      chainTip = await contractReader.getChainTip();
    } catch (tipErr) {
      log.warn("v2 tip check skipped due chain tip fetch failure", { nodeId, error: String(tipErr) });
    }
    if (chainTip) {
      const diff = tipHeight > chainTip.number ? tipHeight - chainTip.number : chainTip.number - tipHeight;
      if (diff > BigInt(v2TipTolerance)) {
        throw new Error("tip height out of tolerance");
      }
    }

    const receiptData = {
      challengeId: challenge.challengeId,
      nodeId: nodeId as `0x${string}`,
      responseAtMs,
      responseBodyHash: responseBodyHash as `0x${string}`,
      tipHash,
      tipHeight,
    };
    const nodeAddr = hex32ToAddress(nodeId);
    if (!agentSignerV2.eip712.verifyTypedData(RECEIPT_TYPES, receiptData, receiptPayload.nodeSig, nodeAddr)) {
      throw new Error("invalid node receipt signature");
    }

    // Collect witnesses
    const witnessResult = v2WitnessNodes.length > 0
      ? await collectWitnesses(
          { witnessNodes: v2WitnessNodes, requiredWitnesses: v2RequiredWitnesses, timeoutMs: 5000 },
          challenge.challengeId,
          nodeId as any,
          responseBodyHash,
        )
      : { attestations: [], bitmap: 0, quorumMet: v2RequiredWitnesses === 0 };

    const evidenceLeaf = {
      epoch: BigInt(currentEpoch),
      nodeId: nodeId as `0x${string}`,
      nonce: challenge.nonce,
      tipHash,
      tipHeight,
      latencyMs: Number(responseAtMs - challenge.issuedAtMs),
      resultCode: witnessResult.quorumMet ? ResultCode.Ok : ResultCode.WitnessQuorumFail,
      witnessBitmap: witnessResult.bitmap,
    };

    const verified: VerifiedReceiptV2 = {
      challenge,
      receipt: {
        challengeId: challenge.challengeId,
        nodeId: nodeId as any,
        responseAtMs,
        responseBody,
        responseBodyHash: responseBodyHash as `0x${string}`,
        tipHash: tipHash as any,
        tipHeight,
        nodeSig: receiptPayload.nodeSig,
      },
      witnesses: witnessResult.attestations,
      witnessBitmap: witnessResult.bitmap,
      evidenceLeaf,
      verifiedAtMs: BigInt(Date.now()),
    };

    pendingV2.push(verified);
    updateScore(nodeId, kind, witnessResult.quorumMet, storageTarget?.fileSize);
  } catch (error) {
    updateScore(nodeId, kind, false);
    log.warn("v2 verification failed", { nodeId, kind, error: String(error) });
  }
}

function stableStringifyAgent(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableStringifyAgent(x)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringifyAgent(obj[k])}`);
  return `{${props.join(",")}}`;
}

async function collectBatchWitnessQuorum(epochId: number, merkleRoot: `0x${string}`): Promise<{
  bitmap: number;
  signatures: string[];
  signedCount: number;
  requiredCount: number;
  quorumMet: boolean;
}> {
  if (!poseV2Contract) {
    return { bitmap: 0, signatures: [], signedCount: 0, requiredCount: 0, quorumMet: true };
  }

  const witnessSetRaw = await poseV2Contract.getWitnessSet(BigInt(epochId)) as string[];
  const witnessSet = witnessSetRaw.map((x) => x.toLowerCase() as `0x${string}`);
  return collectBatchWitnessSignatures(
    merkleRoot,
    witnessSet,
    (nodeId) => resolveNodeEndpointStrict(nodeId),
  );
}

async function flushBatchV2(epochId: number, receipts: VerifiedReceiptV2[]): Promise<boolean> {
  if (!aggregatorV2 || receipts.length === 0) return true;

  try {
    const batch = aggregatorV2.buildBatch(BigInt(epochId), receipts);

    // Compute reward root from epoch scores
    const stats = [...nodeScores.entries()].map(([nodeId, item]) => ({
      nodeId: nodeId as `0x${string}`,
      uptimeBps: ratioBps(item.uptimeOk, item.uptimeTotal),
      storageBps: ratioBps(item.storageOk, item.storageTotal),
      relayBps: ratioBps(item.relayOk, item.relayTotal),
      storageGb: bytesToGb(item.verifiedStorageBytes),
    }));
    const rewardPool = BigInt(config.rewardPoolWei ?? "1000000000000000000");
    const scoringResult = computeEpochRewards(rewardPool, stats);
    const { root: rewardRoot } = buildRewardRoot(BigInt(epochId), scoringResult);

    if (!poseV2Contract) {
      log.info("batchV2(local)", {
        epochId,
        merkleRoot: batch.merkleRoot,
        rewardRoot,
        receipts: receipts.length,
      });
      return true;
    }
    if (!canRunAggregatorRole(epochId)) {
      log.error("batchV2 skipped: no aggregator permission for epoch", { epochId, receipts: receipts.length });
      return false;
    }

    let witnessBitmap = 0;
    let witnessSignatures: string[] = [];
    try {
      const witnessResult = await collectBatchWitnessQuorum(epochId, batch.merkleRoot as `0x${string}`);
      if (witnessResult.quorumMet) {
        witnessBitmap = witnessResult.bitmap;
        witnessSignatures = witnessResult.signatures;
      } else if (!allowEmptyBatchWitnessSubmission && witnessResult.requiredCount > 0) {
        log.error("batchV2 skipped: witness quorum not met and empty fallback disabled", {
          epochId,
          merkleRoot: batch.merkleRoot,
          signed: witnessResult.signedCount,
          required: witnessResult.requiredCount,
        });
        return false;
      } else {
        log.warn("batchV2 witness quorum not met, fallback to empty witness submission", {
          epochId,
          merkleRoot: batch.merkleRoot,
          signed: witnessResult.signedCount,
          required: witnessResult.requiredCount,
        });
      }
    } catch (witnessError) {
      if (!allowEmptyBatchWitnessSubmission) {
        log.error("batchV2 skipped: witness collection failed and empty fallback disabled", {
          epochId,
          merkleRoot: batch.merkleRoot,
          error: String(witnessError),
        });
        return false;
      }
      log.warn("batchV2 witness collection failed, fallback to empty witness submission", {
        epochId,
        merkleRoot: batch.merkleRoot,
        error: String(witnessError),
      });
    }

    const tx = await poseV2Contract.submitBatchV2(
      BigInt(epochId),
      batch.merkleRoot,
      batch.summaryHash,
      batch.sampleProofs,
      witnessBitmap,
      witnessSignatures,
    );
    await tx.wait();

    log.info("batchV2(onchain)", {
      epochId,
      txHash: tx.hash,
      merkleRoot: batch.merkleRoot,
      rewardRoot,
      witnessBitmap,
      witnessSignatures: witnessSignatures.length,
    });
    return true;
  } catch (error) {
    log.error("batchV2 failed", { error: String(error) });
    return false;
  }
}

async function ensureNodeRegistered(): Promise<void> {
  const registerContract = useV2 ? poseV2Contract : poseContract;
  if (!registerContract) {
    return;
  }
  try {
    const pubkey = signer.signingKey.publicKey;
    const nodeId = keccak256(pubkey);
    const node = await registerContract.getNode(nodeId);
    if (node?.active) {
      return;
    }

    // Query progressive bond requirement from contract (v2 uses the same MIN_BOND << operatorNodeCount rule).
    const operatorCount = Number(await registerContract.operatorNodeCount(signer.address));
    const bondRequired = useV2 ? (MIN_BOND_WEI << operatorCount) : await poseContract!.requiredBond(signer.address) as bigint;

    const serviceCommitment = keccak256(toUtf8Bytes(`service:${signer.address.toLowerCase()}`));
    const fingerprint = computeMachineFingerprint(pubkey);
    const endpointCommitment = keccak256(toUtf8Bytes(fingerprint));
    const metadataHash = keccak256(toUtf8Bytes("coc-agent:auto-register"));

    // Build ownership proof matching contract's abi.encodePacked("coc-register:", nodeId, msg.sender)
    // Raw bytes: 13 (string) + 32 (nodeId) + 20 (address) = 65 bytes
    const registerMsgPacked = Buffer.concat([
      Buffer.from("coc-register:", "utf8"),
      Buffer.from(nodeId.slice(2), "hex"),
      Buffer.from(signer.address.toLowerCase().slice(2), "hex"),
    ]);
    const messageHash = keccak256(registerMsgPacked);
    // signBytes applies EIP-191 prefix matching contract's ethSignedHash
    const ownershipSig = agentSigner.signBytes(
      Buffer.from(messageHash.slice(2), "hex"),
    );

    // Build endpoint attestation: node signs "coc-endpoint:{endpointCommitment}:{nodeId}"
    const endpointMsg = `coc-endpoint:${endpointCommitment}:${nodeId}`;
    const endpointAttestation = agentSigner.signBytes(
      Buffer.from(keccak256(toUtf8Bytes(endpointMsg)).slice(2), "hex"),
    );

    const tx = await registerContract.registerNode(
      nodeId,
      pubkey,
      0x07,
      serviceCommitment,
      endpointCommitment,
      metadataHash,
      ownershipSig,
      endpointAttestation,
      { value: bondRequired },
    );
    await tx.wait();
    log.info("registered node onchain", { nodeId, bond: bondRequired.toString(), protocolVersion: useV2 ? 2 : 1 });
  } catch (error) {
    log.error("register node failed", { error: String(error) });
  }
}

async function tryChallenge(nodeId: string, kind: keyof typeof ChallengeType): Promise<void> {
  const targetUrl = resolveNodeEndpoint(nodeId);
  if (!targetUrl) {
    log.warn("challenge skipped: missing node endpoint mapping", { nodeId, protocolVersion: useV2 ? 2 : 1 });
    return;
  }

  const code = ChallengeType[kind];
  const canIssue = quota.canIssue(nodeId as any, BigInt(currentEpoch), code, BigInt(Date.now()));
  if (!canIssue.ok) {
    return;
  }

  const storageTarget = kind === "Storage" ? await pickStorageTarget(storageDir) : null;
  if (kind === "Storage" && !storageTarget) {
    return;
  }

  const challenge = factory.issue({
    epochId: BigInt(currentEpoch),
    nodeId: nodeId as any,
    challengeType: kind,
    randSeed: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    issuedAtMs: BigInt(Date.now()),
    querySpec: buildQuerySpec(kind, storageTarget),
  });

  quota.commitIssue(nodeId as any, BigInt(currentEpoch), code, BigInt(Date.now()));

  let receiptPayload: any | undefined;
  try {
    await requestJson(
      `${targetUrl}/pose/challenge`,
      "POST",
      buildSignedPosePayload("/pose/challenge", challenge as unknown as Record<string, unknown>, agentSigner),
    );
    const receiptResp = await requestJson(
      `${targetUrl}/pose/receipt`,
      "POST",
      buildSignedPosePayload("/pose/receipt", {
        challengeId: challenge.challengeId,
        challengeType: code,
        payload: { nodeId, kind },
      }, agentSigner),
    );
    receiptPayload = receiptResp.json;
  } catch (networkError) {
    log.warn("node unreachable, recording timeout", { nodeId, kind, error: String(networkError) });
    updateScore(nodeId, kind, false);
    const evidence = antiCheat.buildEvidence(EvidenceReason.Timeout, challenge, { nodeId, error: "unreachable" });
    evidenceStore.push(evidence);
    return;
  }

  try {
    const verified = verifier.toVerifiedReceipt(challenge, receiptPayload, BigInt(Date.now()));
    pending.push(verified);
    updateScore(nodeId, kind, true, storageTarget?.fileSize);
  } catch (error) {
    updateScore(nodeId, kind, false);
    const reason = String(error);
    const reasonCode = reason.includes("signature")
      ? EvidenceReason.InvalidSignature
      : reason.includes("timeout")
        ? EvidenceReason.Timeout
        : reason.includes("replay")
          ? EvidenceReason.ReplayNonce
          : reason.includes("storage")
            ? EvidenceReason.StorageProofInvalid
            : EvidenceReason.MissingReceipt;
    const evidence = antiCheat.buildEvidence(reasonCode, challenge, receiptPayload);
    evidenceStore.push(evidence);
  }
}

// Cached latest block number, refreshed each tick
let latestBlockNumber = 0;

async function refreshLatestBlock(): Promise<void> {
  try {
    const bn = await provider.getBlockNumber();
    if (bn > 0) latestBlockNumber = bn;
  } catch {
    // keep previous value on failure
  }
}

function buildQuerySpec(
  kind: keyof typeof ChallengeType,
  storageTarget: { cid: string; chunkIndex: number; merkleRoot: string; fileSize: number } | null
): Record<string, unknown> {
  if (kind === "Storage") {
    return storageTarget
      ? {
          cid: storageTarget.cid,
          chunkIndex: storageTarget.chunkIndex,
          merkleRoot: storageTarget.merkleRoot,
          proofSpec: "merkle-path",
        }
      : { proofSpec: "merkle-path" };
  }
  if (kind === "Relay") {
    return { routeTag: "l1-l2", expectedHop: 1 };
  }
  // Uptime: require blockNumber >= recent block minus tolerance
  const minBlockNumber = latestBlockNumber > 10 ? latestBlockNumber - 10 : 0;
  return { method: "eth_blockNumber", minBlockNumber };
}

async function pickStorageTarget(
  storageDirPath: string,
): Promise<{ cid: string; chunkIndex: number; merkleRoot: string; fileSize: number } | null> {
  const meta = await readFileMeta(storageDirPath);
  const entries = Object.values(meta);
  if (entries.length === 0) {
    log.warn("no storage meta found, skip storage challenge");
    return null;
  }
  const target = entries[Math.floor(Math.random() * entries.length)];
  const leafCount = target.merkleLeaves.length;
  const chunkIndex = leafCount > 0 ? Math.floor(Math.random() * leafCount) : 0;
  return {
    cid: target.cid,
    chunkIndex,
    merkleRoot: target.merkleRoot,
    fileSize: target.size,
  };
}

async function readFileMeta(storageDirPath: string): Promise<Record<string, UnixFsFileMeta>> {
  try {
    const raw = await readFile(join(storageDirPath, "file-meta.json"), "utf-8");
    return JSON.parse(raw) as Record<string, UnixFsFileMeta>;
  } catch {
    return {};
  }
}

function resolveStorageDir(dataDir: string, configured?: string): string {
  if (configured) return configured;
  return join(dataDir, "storage");
}

function computeMerkleRoot(leafHash: Hex, merklePath: Hex[], chunkIndex: number): Hex {
  let hash = leafHash;
  let idx = chunkIndex;
  for (const sibling of merklePath) {
    if (idx % 2 === 0) {
      hash = hashPair(hash, sibling);
    } else {
      hash = hashPair(sibling, hash);
    }
    idx = Math.floor(idx / 2);
  }
  return hash;
}

function updateScore(nodeId: string, kind: keyof typeof ChallengeType, ok: boolean, storageBytes?: number): void {
  const item = nodeScores.get(nodeId) ?? {
    uptimeOk: 0,
    uptimeTotal: 0,
    storageOk: 0,
    storageTotal: 0,
    relayOk: 0,
    relayTotal: 0,
    verifiedStorageBytes: 0,
  };

  if (kind === "Uptime") {
    item.uptimeTotal += 1;
    if (ok) item.uptimeOk += 1;
  } else if (kind === "Storage") {
    item.storageTotal += 1;
    if (ok) {
      item.storageOk += 1;
      if (storageBytes && storageBytes > 0) {
        item.verifiedStorageBytes += storageBytes;
      }
    }
  } else {
    item.relayTotal += 1;
    if (ok) item.relayOk += 1;
  }

  nodeScores.set(nodeId, item);
}

function bytesToGb(bytes: number): bigint {
  const gb = Math.floor(bytes / (1024 * 1024 * 1024));
  return BigInt(gb > 0 ? gb : bytes > 0 ? 1 : 0);
}

function emitEpochScores(epochId: number): void {
  const stats = [...nodeScores.entries()].map(([nodeId, item]) => ({
    nodeId: nodeId as `0x${string}`,
    uptimeBps: ratioBps(item.uptimeOk, item.uptimeTotal),
    storageBps: ratioBps(item.storageOk, item.storageTotal),
    relayBps: ratioBps(item.relayOk, item.relayTotal),
    storageGb: bytesToGb(item.verifiedStorageBytes),
  }));

  const rewardPool = BigInt(config.rewardPoolWei ?? "1000000000000000000");
  const rewards = computeEpochRewards(rewardPool, stats);
  log.info("epoch rewards", {
    epochId,
    rewards: rewards.rewards,
    overflow: rewards.treasuryOverflow.toString(),
    capped: rewards.cappedNodes,
  });
}

function ratioBps(ok: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((ok / total) * 10_000);
}

async function flushBatch(epochId: number, receipts: Array<any>): Promise<boolean> {
  if (receipts.length === 0) return true;
  try {
    const batch = aggregator.buildBatch(BigInt(epochId), receipts);

    if (!poseContract) {
      log.info("batch(local)", {
        epochId,
        merkleRoot: batch.merkleRoot,
        summaryHash: batch.summaryHash,
        sampleProofs: batch.sampleProofs.length,
      });
      return true;
    }
    if (!canRunAggregatorRole(epochId)) {
      log.error("batch skipped: no aggregator permission for epoch", { epochId, receipts: receipts.length });
      return false;
    }

    const tx = await poseContract.submitBatch(BigInt(epochId), batch.merkleRoot, batch.summaryHash, batch.sampleProofs);
    const receipt = await tx.wait();

    try {
      const nodeId = keccak256(signer.signingKey.publicKey);
      const newCommitment = keccak256(toUtf8Bytes(`${nodeUrl}:${Date.now()}`));
      await poseContract.updateCommitment(nodeId, newCommitment);
    } catch {
      // ignore commitment update failures
    }

    log.info("batch(onchain)", {
      epochId,
      txHash: tx.hash,
      status: receipt?.status,
      merkleRoot: batch.merkleRoot,
      summaryHash: batch.summaryHash,
      sampleProofs: batch.sampleProofs.length,
    });
    return true;
  } catch (error) {
    log.error("batch failed", { error: String(error) });
    return false;
  }
}

// Track whether our own node is registered onchain
let selfNodeRegistered = false;

async function refreshSelfNodeStatus(): Promise<void> {
  const statusContract = useV2 ? poseV2Contract : poseContract;
  if (!statusContract) {
    selfNodeRegistered = false;
    return;
  }
  try {
    const pubkey = signer.signingKey.publicKey;
    const nodeId = keccak256(pubkey);
    const node = await statusContract.getNode(nodeId);
    selfNodeRegistered = Boolean(node?.active);
  } catch {
    // keep previous value on failure
  }
}

function canRunForEpochRole(epochId: number): boolean {
  if (challengerSet.length === 0) {
    // When no explicit challengerSet, require the agent to be a registered node
    return selfNodeRegistered;
  }
  const slot = epochId % challengerSet.length;
  return challengerSet[slot] === signer.address.toLowerCase();
}

function canRunAggregatorRole(epochId: number): boolean {
  if (aggregatorSet.length === 0) {
    return selfNodeRegistered;
  }
  const slot = epochId % aggregatorSet.length;
  return aggregatorSet[slot] === signer.address.toLowerCase();
}

function normalizeNodeIds(input: string[] | undefined): string[] {
  if (!input || input.length === 0) {
    return ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
  }
  return input.map((x) => x.toLowerCase());
}

function normalizeNodeEndpointMap(input: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!input) return map;
  for (const [nodeId, url] of Object.entries(input)) {
    if (!nodeId || typeof url !== "string" || url.length === 0) continue;
    map.set(nodeId.toLowerCase(), url);
  }
  return map;
}

function resolveNodeEndpoint(nodeId: string): string | null {
  const mapped = nodeEndpointMap.get(nodeId.toLowerCase());
  if (mapped) return mapped;
  if (trackedNodeIds.length === 1) return nodeUrl;
  return null;
}

function resolveNodeEndpointStrict(nodeId: string): string | null {
  return nodeEndpointMap.get(nodeId.toLowerCase()) ?? null;
}

function currentEpochId(): number {
  const now = Date.now();
  return Math.floor(now / (60 * 60 * 1000));
}

function normalizeInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function resolveEndpointFingerprintMode(input: unknown): "strict" | "legacy" {
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "legacy" || normalized === "strict") {
      return normalized;
    }
  }
  return "strict";
}

setInterval(() => void tick(), intervalMs);
void tick();
