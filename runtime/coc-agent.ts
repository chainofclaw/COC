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
import { AntiCheatPolicy, EvidenceReason, type SlashEvidence } from "../services/verifier/anti-cheat-policy.ts";
import { keccak256Hex } from "../services/relayer/keccak256.ts";
import { ChallengeType } from "../services/common/pose-types.ts";
import type { ChallengeMessageV2, VerifiedReceiptV2 } from "../services/common/pose-types-v2.ts";
import { ResultCode } from "../services/common/pose-types-v2.ts";
import { buildMerkleProof } from "../services/common/merkle.ts";
import { hashPair } from "../node/src/ipfs-merkle.ts";
import type { UnixFsFileMeta, Hex } from "../node/src/ipfs-types.ts";
import { IpfsBlockstore } from "../node/src/ipfs-blockstore.ts";
import { CidRegistryReader, makeCidRegistryEventReader } from "./lib/cid-registry-reader.ts";
import type { DhtLike } from "./lib/cid-registry-reader.ts";
import { verifiedStorageBytesFor } from "./lib/pose-score.ts";
import { auditStorageReceipt, type StorageAuditDeps } from "../services/verifier/storage-audit.ts";
import { createLogger } from "../node/src/logger.ts";
import { createNodeSigner, createNodeSignerV2, buildReceiptSignMessage } from "../node/src/crypto/signer.ts";
import { buildDomain, CHALLENGE_TYPES, RECEIPT_TYPES, REWARD_MANIFEST_TYPES } from "../node/src/crypto/eip712-types.ts";
import { buildSignedPosePayload } from "../node/src/pose-http.ts";
import { collectBatchWitnessSignatures, collectWitnesses } from "./lib/witness-collector.ts";
import { ContractReader } from "./lib/contract-reader.ts";
import { extractPendingV1Epoch, extractPendingV2Epoch, pruneStoreByEpoch } from "./lib/pending-retention.ts";
import { buildPrometheusMetrics, shouldWriteMetrics, writeMetricsSnapshot, writePrometheusMetrics, type RuntimeMetricsSnapshot } from "./lib/runtime-metrics.ts";
import { startAgentMetricsServer } from "./lib/agent-metrics-server.ts";
import { faultTypeForResultCode, serializeEvidenceLeaf } from "./lib/pose-v2-fault-proof.ts";
import {
  stableStringifyForHash,
  writeRewardManifest,
  manifestSigningPayload,
  type ChallengerRewardEntry,
  type RewardManifest,
} from "./lib/reward-manifest.ts";
import { resolveEvidencePaths } from "../services/common/slash-evidence.ts";
import { resolvePrivateKey } from "./lib/key-material.ts";
import { retryAsync } from "./lib/retry.ts";
import { RuntimeNodeOpsController } from "./lib/nodeops-runtime.ts";
import { listActiveNodeIds } from "./lib/active-node-resolver.ts";

const log = createLogger("coc-agent");

const config = await loadConfig();
const nodeUrl = process.env.COC_NODE_URL || config.nodeUrl || "http://127.0.0.1:18780";
const intervalMs = normalizeInt(process.env.COC_AGENT_INTERVAL_MS || config.agentIntervalMs, 60000);
const batchSize = normalizeInt(process.env.COC_AGENT_BATCH_SIZE || config.agentBatchSize, 5);
const sampleSize = normalizeInt(process.env.COC_AGENT_SAMPLE_SIZE || config.agentSampleSize, 2);
const storageDir = resolveStorageDir(config.dataDir, config.storageDir);
const rewardManifestDir = config.rewardManifestDir ?? join(config.dataDir, "reward-manifests");
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
const operatorPrivateKey = resolvePrivateKey({
  envValue: process.env.COC_OPERATOR_PK,
  envFilePath: process.env.COC_OPERATOR_PK_FILE,
  configValue: config.operatorPrivateKey,
  configFilePath: config.operatorPrivateKeyFile,
  label: "operator",
});
const txRetryOptions = {
  retries: Math.max(0, Number(process.env.COC_TX_RETRY_ATTEMPTS || (config.txRetryAttempts ?? 2))),
  baseDelayMs: Math.max(1, Number(process.env.COC_TX_RETRY_BASE_DELAY_MS || (config.txRetryBaseDelayMs ?? 250))),
  maxDelayMs: Math.max(1, Number(process.env.COC_TX_RETRY_MAX_DELAY_MS || (config.txRetryMaxDelayMs ?? 5000))),
  onRetry: (error: unknown, attempt: number, delayMs: number) => {
    log.warn("retrying runtime tx operation", { attempt, delayMs, error: String(error) });
  },
};

const provider = new JsonRpcProvider(l1RpcUrl);
const signer = new Wallet(operatorPrivateKey, provider);
const agentSigner = createNodeSigner(operatorPrivateKey);
const localAgentNodeId = keccak256(signer.signingKey.publicKey).toLowerCase() as `0x${string}`;
const challengerSet = (config.challengerSet ?? []).map((x) => x.toLowerCase());
const aggregatorSet = (config.aggregatorSet ?? []).map((x) => x.toLowerCase());

// Phase C2.2: optionally source Storage-challenge targets from the on-chain
// CidRegistry + DHT pre-filter instead of a per-agent local file-meta.json.
// The reader is constructed lazily (see below near agent startup) because
// it needs a CidRegistry contract binding + a DHT proxy, neither of which
// exist at module-top scope. Kept as `let` so `pickStorageTarget` can
// read its current value even after async initialization.
let cidRegistryReader: CidRegistryReader | null = null;

// Phase C2.4: deps for sampled audit re-fetch of storage receipts.
// Populated in initCidRegistryReader alongside the CidRegistryReader (they
// share the DHT proxy). Null until init completes; the audit short-
// circuits to "not-sampled" in that case so the first ticks don't fail.
let storageAuditDeps: StorageAuditDeps | null = null;

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

/**
 * Phase C: resolve the signer address for a PoSe v2 nodeId.
 *
 * Legacy convention: nodeId = validator address left-padded to bytes32.
 * Phase C / PoSe v2 convention: nodeId = keccak256(pubkey), which is a
 * completely different 32-byte hash from the validator's ETH address.
 *
 * The contract stores the pubkey in NodeRecord.pubkeyNode, so we read
 * it on demand and derive the address via ethers `computeAddress`
 * (= keccak256(pubkey[1:])[-20:] — the standard secp256k1 address).
 *
 * Cached in memory to avoid hitting the chain on every tick. Cache key
 * is lowercased nodeId. Entries are immutable (a node's pubkey doesn't
 * change post-registration) so no invalidation needed.
 */
const nodeSignerAddressCache = new Map<string, string>();
async function resolveNodeSignerAddress(
  nodeId: string,
  getNode?: (nodeId: string) => Promise<{ pubkeyNode?: string } | null>,
): Promise<string> {
  const key = nodeId.toLowerCase();
  const cached = nodeSignerAddressCache.get(key);
  if (cached) return cached;
  if (getNode) {
    try {
      const record = await getNode(nodeId);
      const pk = record?.pubkeyNode;
      if (pk && typeof pk === "string" && pk.startsWith("0x") && pk.length >= 132) {
        // ethers computeAddress expects 0x04-prefixed uncompressed or
        // 0x02/0x03-prefixed compressed; NodeRecord.pubkey is 0x04||X||Y
        const { computeAddress } = await import("ethers");
        const addr = computeAddress(pk).toLowerCase();
        nodeSignerAddressCache.set(key, addr);
        log.info("resolveNodeSignerAddress: on-chain pubkey resolved", { nodeId, addr });
        return addr;
      }
      log.warn("resolveNodeSignerAddress: getNode returned no/short pubkey", { nodeId, pkLen: pk?.length ?? -1 });
    } catch (err) {
      log.warn("resolveNodeSignerAddress on-chain lookup failed", { nodeId, error: String(err) });
    }
  }
  // Legacy fallback: nodeId is a bytes32-padded address.
  const fallback = hex32ToAddress(nodeId);
  log.warn("resolveNodeSignerAddress: falling back to hex32ToAddress (likely wrong for v2 nodes)", { nodeId, fallback });
  return fallback;
}

const poseAbi = [
  "event NodeRegistered(bytes32 indexed nodeId, address indexed operator, uint8 serviceFlags, uint256 bondAmount)",
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
// Production default: strict (false). Set to true only for dev/test environments.
const allowEmptyBatchWitnessSubmission = config.allowEmptyBatchWitnessSubmission ?? false;
const v2TipTolerance = config.tipToleranceBlocks ?? 10;

const poseV2Abi = [
  "event NodeRegistered(bytes32 indexed nodeId, address indexed operator, uint8 serviceFlags, uint256 bondAmount)",
  "function initEpochNonce(uint64 epochId)",
  "function submitBatchV2(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, tuple(bytes32 leaf, bytes32[] merkleProof, uint32 leafIndex)[] sampleProofs, uint32 witnessBitmap, bytes[] witnessSignatures) returns (bytes32 batchId)",
  // #667 — `submitBatchV2WithMetadata`. ReceiptBatchMetadata struct fields:
  //   challengeIds[]; nodeIds[]; responseBodyHashes[]; leafHashes[]; witnessReceiptIndex[32]
  "function submitBatchV2WithMetadata(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, tuple(bytes32 leaf, bytes32[] merkleProof, uint32 leafIndex)[] sampleProofs, uint32 witnessBitmap, bytes[] witnessSignatures, tuple(bytes32[] challengeIds, bytes32[] nodeIds, bytes32[] responseBodyHashes, bytes32[] leafHashes, uint16[32] witnessReceiptIndex) metadata) returns (bytes32 batchId)",
  "function getActiveNodeCount() view returns (uint256)",
  "function getActiveNodeIds(uint256 offset, uint256 limit) view returns (bytes32[])",
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
interface RewardTargetSnapshot {
  epochId: number;
  nodeIds: string[];
  challengeableNodeIds: string[];
  missingEndpointNodeIds: string[];
  source: "config" | "chain";
}

let rewardTargets: RewardTargetSnapshot = {
  epochId: -1,
  nodeIds: [...trackedNodeIds],
  challengeableNodeIds: [],
  missingEndpointNodeIds: [],
  source: "config",
};

interface EpochChallengerStats {
  challengerAddress: string;
  nodeId: string;
  challengeCount: number;
  validReceiptCount: number;
}

const challengerRewardStats = new Map<number, EpochChallengerStats>();

function recordValidChallengerReceipt(epochId: number): void {
  const stats = challengerRewardStats.get(epochId) ?? {
    challengerAddress: signer.address.toLowerCase(),
    nodeId: localAgentNodeId,
    challengeCount: 0,
    validReceiptCount: 0,
  };
  stats.challengeCount += 1;
  stats.validReceiptCount += 1;
  challengerRewardStats.set(epochId, stats);
}

function buildChallengerRewardsForEpoch(epochId: number): ChallengerRewardEntry[] {
  const stats = challengerRewardStats.get(epochId);
  if (!stats || stats.validReceiptCount === 0) {
    return [];
  }
  return [{
    challengerAddress: stats.challengerAddress,
    nodeId: stats.nodeId,
    challengeCount: stats.challengeCount,
    validReceiptCount: stats.validReceiptCount,
  }];
}

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
const agentMetricsPath = process.env.COC_AGENT_METRICS_PATH || config.agentMetricsPath || join(config.dataDir, "agent-metrics.json");
const agentMetricsPromPath = process.env.COC_AGENT_METRICS_PROM_PATH || config.agentMetricsPromPath || join(config.dataDir, "agent-metrics.prom");
const agentMetricsBind = process.env.COC_AGENT_METRICS_BIND || config.agentMetricsBind || "127.0.0.1";
const agentMetricsPort = normalizeNonNegativeInt(
  process.env.COC_AGENT_METRICS_PORT || config.agentMetricsPort,
  0,
);
const agentMetricsIntervalMs = normalizeInt(
  process.env.COC_AGENT_METRICS_INTERVAL_MS || config.agentMetricsIntervalMs,
  10_000,
);
const tickOverlapLogIntervalMs = normalizeInt(
  process.env.COC_TICK_OVERLAP_LOG_INTERVAL_MS || config.tickOverlapLogIntervalMs,
  30_000,
);
const pending = new PendingReceiptStore<any>(pendingPath, "v1");
const pendingV2 = new PendingReceiptStore<VerifiedReceiptV2>(pendingV2Path, "v2");
const runtimeStats = {
  pruneRemovedV1: 0,
  pruneRemovedV2: 0,
  pruneArchiveFailedV1: 0,
  pruneArchiveFailedV2: 0,
  roleMismatchV1: 0,
  roleMismatchV2: 0,
  tickOverlapSkipped: 0,
  tickOverlapLogSuppressed: 0,
  metricsWriteFailed: 0,
  metricsPromWriteFailed: 0,
  witnessFallbackCount: 0,
};
let lastMetricsWriteAtMs = 0;
let tickInProgress = false;
let tickStartedAtMs = 0;
const TICK_HANG_TIMEOUT_MS = 5 * 60 * 1000;
let lastTickOverlapLogAtMs = 0;
let tickOverlapSuppressedSinceLastLog = 0;
let selfNodeRegistered = false;
let currentEpoch = currentEpochId();
log.info("endpoint fingerprint mode", { mode: endpointFingerprintMode });

if (agentMetricsPort > 0) {
  try {
    await startAgentMetricsServer({
      bind: agentMetricsBind,
      port: agentMetricsPort,
      getPrometheus: () => buildPrometheusMetrics(buildRuntimeMetricsSnapshot(currentEpoch, Date.now())),
    });
  } catch (error) {
    log.error("agent metrics server failed to start", {
      bind: agentMetricsBind,
      port: agentMetricsPort,
      error: String(error),
    });
  }
}

if (useV2 && trackedNodeIds.length > 1) {
  const missing = trackedNodeIds.filter((id) => !nodeEndpointMap.has(id.toLowerCase()));
  if (missing.length > 0) {
    log.warn("v2 mode: missing nodeEndpoints mapping for tracked nodes; these nodes will be skipped", { missing });
  }
}

// Evidence pipeline: agent writes, relayer consumes
const evidencePath = resolveEvidencePaths(config.dataDir, process.env.COC_EVIDENCE_PATH).writePath;
export const evidenceStore = new EvidenceStore(1000, evidencePath);
const antiCheat = new AntiCheatPolicy();
const nodeOpsPolicyPath = process.env.COC_NODEOPS_POLICY_PATH || config.nodeOpsPolicyPath;
const nodeOps = nodeOpsPolicyPath
  ? new RuntimeNodeOpsController({
      dataDir: config.dataDir,
      nodeUrl,
      policyPath: nodeOpsPolicyPath,
      hotReload: config.nodeOpsHotReload ?? true,
      allowSelfRestart: config.nodeOpsAllowSelfRestart ?? false,
      actionDir: config.nodeOpsActionDir,
    })
  : null;

if (nodeOps) {
  await nodeOps.init();
}

await ensureNodeRegistered();
await refreshRewardTargets(currentEpoch);

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

function buildRuntimeMetricsSnapshot(nowEpoch: number, nowMs: number): RuntimeMetricsSnapshot {
  return {
    generatedAtMs: nowMs,
    protocolVersion: useV2 ? 2 : 1,
    address: signer.address.toLowerCase(),
    selfNodeRegistered,
    currentEpoch: nowEpoch,
    pendingV1: pending.length,
    pendingV2: pendingV2.length,
    counters: { ...runtimeStats },
  };
}

function writeRuntimeMetrics(nowEpoch: number, nowMs: number): void {
  if (!shouldWriteMetrics(nowMs, lastMetricsWriteAtMs, agentMetricsIntervalMs)) {
    return;
  }
  let hasSuccess = false;
  try {
    writeMetricsSnapshot(agentMetricsPath, buildRuntimeMetricsSnapshot(nowEpoch, nowMs));
    hasSuccess = true;
  } catch (error) {
    runtimeStats.metricsWriteFailed += 1;
    log.error("runtime metrics write failed", {
      path: agentMetricsPath,
      error: String(error),
    });
  }
  try {
    writePrometheusMetrics(agentMetricsPromPath, buildRuntimeMetricsSnapshot(nowEpoch, nowMs));
    hasSuccess = true;
  } catch (error) {
    runtimeStats.metricsPromWriteFailed += 1;
    log.error("runtime metrics prometheus write failed", {
      path: agentMetricsPromPath,
      error: String(error),
    });
  }
  if (hasSuccess) {
    lastMetricsWriteAtMs = nowMs;
  }
}

async function tick(): Promise<void> {
  if (tickInProgress) {
    runtimeStats.tickOverlapSkipped += 1;
    const nowMs = Date.now();
    const shouldLog =
      lastTickOverlapLogAtMs === 0 ||
      nowMs - lastTickOverlapLogAtMs >= tickOverlapLogIntervalMs;
    if (shouldLog) {
      log.warn("tick skipped: previous tick still in progress", {
        tickOverlapSkipped: runtimeStats.tickOverlapSkipped,
        suppressedSinceLast: tickOverlapSuppressedSinceLastLog,
        throttleMs: tickOverlapLogIntervalMs,
      });
      lastTickOverlapLogAtMs = nowMs;
      tickOverlapSuppressedSinceLastLog = 0;
    } else {
      tickOverlapSuppressedSinceLastLog += 1;
      runtimeStats.tickOverlapLogSuppressed += 1;
    }
    return;
  }
  tickInProgress = true;
  tickStartedAtMs = Date.now();
  try {
    await refreshLatestBlock();
    await refreshSelfNodeStatus();
    const nowEpoch = currentEpochId();
    const nowMs = Date.now();
    pruneStalePending(nowEpoch);
    await refreshRewardTargets(currentEpoch);

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
        await refreshRewardTargets(currentEpoch);
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

      for (const nodeId of rewardTargets.challengeableNodeIds) {
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
        await persistRewardManifestForEpoch(currentEpoch);
        nodeScores.clear();
        currentEpoch = nowEpoch;
        await refreshRewardTargets(currentEpoch);
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

      for (const nodeId of rewardTargets.challengeableNodeIds) {
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

    writeRuntimeMetrics(currentEpoch, nowMs);
    if (nodeOps) {
      const actions = await nodeOps.tick(nowMs);
      if (actions.length > 0) {
        log.info("nodeops actions applied", {
          count: actions.length,
          actions: actions.map((action) => ({ type: action.type, reason: action.reason })),
        });
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
      tickOverlapSkipped: runtimeStats.tickOverlapSkipped,
      tickOverlapLogSuppressed: runtimeStats.tickOverlapLogSuppressed,
      metricsWriteFailed: runtimeStats.metricsWriteFailed,
      metricsPromWriteFailed: runtimeStats.metricsPromWriteFailed,
    });
  } catch (error) {
    log.error("tick failed", { error: String(error) });
  } finally {
    tickInProgress = false;
    tickStartedAtMs = 0;
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
  } catch {
    // nonce fetch failed
  }
  if (challengeNonce === 0n && (config.epochNonceStrict ?? false)) {
    log.warn("v2 challenge skipped: epoch nonce not initialized (strict mode)", { nodeId, epochId: currentEpoch });
    return;
  }

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
    // Phase C: nodeId is keccak256(pubkey), not an ETH address. The
    // actual signer address is computeAddress(pubkey), which we look up
    // from the on-chain NodeRecord (cached per nodeId so we hit the
    // chain once per peer).
    const nodeAddr = await resolveNodeSignerAddress(
      nodeId,
      poseV2Contract ? async (id) => (await poseV2Contract.getNode(id)) as { pubkeyNode?: string } : undefined,
    );
    const sigOk = agentSignerV2.eip712.verifyTypedData(RECEIPT_TYPES, receiptData, receiptPayload.nodeSig, nodeAddr);
    if (!sigOk) {
      log.warn("debug: v2 sig verify failed", {
        nodeId, nodeAddr,
        challengeId: receiptData.challengeId,
        responseAtMs: receiptData.responseAtMs.toString(),
        responseBodyHash: receiptData.responseBodyHash,
        tipHash: receiptData.tipHash,
        tipHeight: receiptData.tipHeight.toString(),
        sigLen: receiptPayload.nodeSig.length,
      });
      throw new Error("invalid node receipt signature");
    }

    // Collect witnesses.
    //
    // #667 (audit follow-up, 2026-05-26) — also pass the push-verification
    // context so witnesses can validate the prover's nodeSig + recompute
    // responseBodyHash before signing. Without the push fields the
    // witness server's COC_POSE_WITNESS_REQUIRE_VERIFIED=true mode would
    // refuse to sign (strict rollout); without strict mode it would
    // silently fall back to the legacy rubber-stamp path. Pushing the
    // fields keeps the agent's behaviour identical regardless of which
    // mode each witness operator chose.
    const witnessResult = v2WitnessNodes.length > 0
      ? await collectWitnesses(
          { witnessNodes: v2WitnessNodes, requiredWitnesses: v2RequiredWitnesses, timeoutMs: 5000 },
          challenge.challengeId,
          nodeId as any,
          responseBodyHash,
          undefined, // requestFn defaults to requestJson
          BigInt(currentEpoch),
          {
            responseBody,
            responseAtMs: Number(responseAtMs),
            nodeSig: receiptPayload.nodeSig,
            tipHash: tipHash as string,
            tipHeight,
          },
        )
      : { attestations: [], bitmap: 0, quorumMet: v2RequiredWitnesses === 0 };

    // Phase C2.4: 5% audit sampling on Storage receipts. The auditor
    // pulls the chunk from an independent peer and recomputes leafHash.
    // On sampled mismatch we stamp ResultCode.InvalidStorageAudit
    // instead of Ok — still records the witness quorum status so it
    // doesn't falsely wipe an otherwise-passing witness result.
    // Sampling is skipped entirely when the audit deps aren't wired
    // (FF off, or init hasn't completed yet) — receipts then behave
    // identically to the pre-C2.4 path.
    let auditVerdict: "pass" | "fail" | "skipped" = "skipped";
    if (kind === "Storage" && storageAuditDeps) {
      const responseBody = receiptPayload.responseBody as Record<string, unknown> | undefined;
      const claimedLeafHash = typeof responseBody?.leafHash === "string" ? responseBody.leafHash : null;
      const claimedCid = typeof responseBody?.cid === "string" ? responseBody.cid : null;
      if (claimedLeafHash && claimedCid) {
        const result = await auditStorageReceipt(storageAuditDeps, {
          cid: claimedCid,
          leafHash: claimedLeafHash,
          proverNodeId: nodeId,
          chunkIndex: typeof responseBody?.chunkIndex === "number" ? responseBody.chunkIndex : undefined,
        });
        if (result.audited && !result.passed) {
          auditVerdict = "fail";
          log.warn("storage audit detected leafHash mismatch — flagging prover", {
            nodeId, cid: claimedCid,
            expected: result.expected,
            actual: result.actual,
          });
        } else if (result.audited) {
          auditVerdict = "pass";
        }
      }
    }

    const resultCode = auditVerdict === "fail"
      ? ResultCode.InvalidStorageAudit
      : witnessResult.quorumMet ? ResultCode.Ok : ResultCode.WitnessQuorumFail;

    const evidenceLeaf = {
      epoch: BigInt(currentEpoch),
      nodeId: nodeId as `0x${string}`,
      nonce: challenge.nonce,
      tipHash,
      tipHeight,
      latencyMs: Number(responseAtMs - challenge.issuedAtMs),
      resultCode,
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
    // Storage challenges fail scoring when either the witness quorum
    // didn't meet (legacy signal) OR Phase C2.4's audit caught the
    // prover returning a bad leafHash. storageGb credit only accrues on
    // both pass — the audit-failed path drops the accumulator since the
    // prover lied about what it holds.
    const storageOk = witnessResult.quorumMet && auditVerdict !== "fail";
    updateScore(nodeId, kind, storageOk, verifiedStorageBytesFor(storageTarget));
    if (storageOk) {
      recordValidChallengerReceipt(currentEpoch);
    }
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

function popcount(n: number): number {
  let count = 0;
  let v = n;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

/**
 * #667 — read the on-chain witness quorum threshold for an epoch. Returns
 * `ceil(2m/3)` where `m = getWitnessSet(epochId).length`. When no witness
 * set exists (early-network, isolated single-node devnet) returns 0, which
 * lets `flushBatchV2` skip the quorum-fallback path entirely.
 */
async function computeWitnessQuorumThreshold(epochId: number): Promise<number> {
  if (!poseV2Contract) return 0;
  try {
    const witnessSet = (await poseV2Contract.getWitnessSet(BigInt(epochId))) as string[];
    const m = witnessSet.length;
    if (m === 0) return 0;
    return Math.floor((2 * m + 2) / 3); // ceil(2m/3)
  } catch {
    return 0;
  }
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

    const manifest = await persistRewardManifestForEpoch(epochId);
    const rewardRoot = manifest.rewardRoot;
    const totalReward = BigInt(manifest.totalReward);

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

    // #667 — witness signatures now come from the per-receipt path collected
    // by verifier-v2 at the receipt level (each receipt carries the witness
    // attestations it actually received). The aggregator-built `batch`
    // exposes them as `witnessSignatures` aligned with `witnessBitmap` set
    // bits, plus a `metadata` payload the contract uses to rebuild EIP-712
    // digests from ORIGINAL (challengeId, nodeId, responseBodyHash) instead
    // of the batch merkleRoot.
    //
    // Fallback: when the per-receipt witnesses don't meet the on-chain
    // quorum threshold and `allowEmptyBatchWitnessSubmission` is set, the
    // owner-only empty-witness path lets the batch still settle (matches
    // pre-#667 behaviour). The legacy `collectBatchWitnessQuorum` is no
    // longer called — its "witness signs batch root" model is the #667
    // root cause and lives in deprecated form for backwards reads only.
    let witnessBitmap = batch.witnessBitmap;
    let witnessSignatures: string[] = batch.witnessSignatures;
    let usingEmptyFallback = false;

    const requiredCount = await computeWitnessQuorumThreshold(epochId);
    const signedCount = popcount(witnessBitmap);
    if (requiredCount > 0 && signedCount < requiredCount) {
      if (!allowEmptyBatchWitnessSubmission) {
        log.error("batchV2 skipped: per-receipt witness quorum not met and empty fallback disabled", {
          epochId,
          merkleRoot: batch.merkleRoot,
          signed: signedCount,
          required: requiredCount,
        });
        return false;
      }
      runtimeStats.witnessFallbackCount += 1;
      log.warn("batchV2 witness quorum not met, fallback to empty witness submission", {
        epochId,
        merkleRoot: batch.merkleRoot,
        signed: signedCount,
        required: requiredCount,
        totalFallbacks: runtimeStats.witnessFallbackCount,
      });
      witnessBitmap = 0;
      witnessSignatures = [];
      usingEmptyFallback = true;
    }

    const tx = await retryAsync(
      () => usingEmptyFallback
        // Empty-witness path stays on the legacy ABI — bypasses metadata
        // verification altogether (owner-only on-chain guard handles it).
        ? poseV2Contract.submitBatchV2(
            BigInt(epochId),
            batch.merkleRoot,
            batch.summaryHash,
            batch.sampleProofs,
            witnessBitmap,
            witnessSignatures,
          )
        : poseV2Contract.submitBatchV2WithMetadata(
            BigInt(epochId),
            batch.merkleRoot,
            batch.summaryHash,
            batch.sampleProofs,
            witnessBitmap,
            witnessSignatures,
            {
              challengeIds: batch.metadata.challengeIds,
              nodeIds: batch.metadata.nodeIds,
              responseBodyHashes: batch.metadata.responseBodyHashes,
              leafHashes: batch.metadata.leafHashes,
              witnessReceiptIndex: batch.metadata.witnessReceiptIndex,
            },
          ),
      txRetryOptions,
    );
    const txReceipt = await retryAsync(() => tx.wait(), txRetryOptions);
    const batchId = extractBatchIdV2(txReceipt?.logs ?? []);
    if (batchId) {
      const queuedFaults = persistV2FaultProofs(batchId, batch.leafHashes, receipts);
      if (queuedFaults > 0) {
        log.info("batchV2 fault proofs queued", { epochId, batchId, queuedFaults });
      }
    } else {
      log.warn("batchV2 submitted but batchId event not found; v2 fault proofs not queued", { epochId, txHash: tx.hash });
    }

    log.info("batchV2(onchain)", {
      epochId,
      txHash: tx.hash,
      batchId,
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
    const node = await retryAsync(() => registerContract.getNode(nodeId), txRetryOptions);
    if (node?.active) {
      return;
    }

    // Query progressive bond requirement from contract (v2 uses the same MIN_BOND << operatorNodeCount rule).
    const operatorCount = Number(await retryAsync(() => registerContract.operatorNodeCount(signer.address), txRetryOptions));
    // MIN_BOND_WEI is BigInt; operatorCount comes from Number(...). The
    // `<<` operator rejects mixed types, so convert to BigInt explicitly.
    const bondRequired = useV2 ? (MIN_BOND_WEI << BigInt(operatorCount)) : await retryAsync(() => poseContract!.requiredBond(signer.address) as Promise<bigint>, txRetryOptions);

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

    // Build endpoint attestation matching contract's
    //   keccak256(abi.encodePacked("coc-endpoint:", endpointCommitment, nodeId))
    // abi.encodePacked with a string + two bytes32 = 13 + 32 + 32 = 77 bytes.
    // Previous UTF-8 `"coc-endpoint:${hex}:${hex}"` form produced a completely
    // different digest and made every v2 registerNode tx revert.
    const endpointPacked = Buffer.concat([
      Buffer.from("coc-endpoint:", "utf8"),
      Buffer.from(endpointCommitment.slice(2), "hex"),
      Buffer.from(nodeId.slice(2), "hex"),
    ]);
    const endpointHash = keccak256(endpointPacked);
    const endpointAttestation = agentSigner.signBytes(
      Buffer.from(endpointHash.slice(2), "hex"),
    );

    const tx = await retryAsync(
      () => registerContract.registerNode(
        nodeId,
        pubkey,
        0x07,
        serviceCommitment,
        endpointCommitment,
        metadataHash,
        ownershipSig,
        endpointAttestation,
        { value: bondRequired },
      ),
      txRetryOptions,
    );
    await retryAsync(() => tx.wait(), txRetryOptions);
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
    updateScore(nodeId, kind, true, verifiedStorageBytesFor(storageTarget));
    recordValidChallengerReceipt(currentEpoch);
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

/**
 * Pick a Storage-challenge target. Two paths, gated on FF
 * `poseStorageFromBlockstore` (runtime/lib/config.ts):
 *
 *   - FF on (Phase C2.2+C2.3): source CIDs from the on-chain CidRegistry
 *     event log, filter out CIDs with zero DHT providers, resolve
 *     merkle metadata via the blockstore fetch-or-serve path. Returns
 *     `chunkSize` — the byte length of the specific chunk being
 *     challenged, which C2.3's verifiedStorageBytes accumulator
 *     credits on a successful verification.
 *   - FF off (legacy): read local `file-meta.json`. Returns `fileSize`
 *     (whole-file bytes), the pre-C2.3 metric. Retained so existing
 *     deployments' scoring behavior doesn't shift before the operator
 *     opts in.
 *
 * Both fields are optional — callers must prefer `chunkSize` over
 * `fileSize`, falling back only when the FF-off path is in use.
 */
async function pickStorageTarget(
  storageDirPath: string,
): Promise<{ cid: string; chunkIndex: number; merkleRoot: string; fileSize?: number; chunkSize?: number } | null> {
  if (cidRegistryReader) {
    const target = await cidRegistryReader.pickRandomChallengeTarget();
    if (!target) {
      log.warn("no viable challenge target from CidRegistry (all monopoly CIDs or empty pool)");
      return null;
    }
    return {
      cid: target.cid,
      chunkIndex: target.chunkIndex,
      merkleRoot: target.merkleRoot,
      chunkSize: target.chunkSize,
    };
  }
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

function collectEpochStats(nodeIds: readonly string[]) {
  return nodeIds.map((nodeId) => {
    const item = nodeScores.get(nodeId) ?? {
      uptimeOk: 0,
      uptimeTotal: 0,
      storageOk: 0,
      storageTotal: 0,
      relayOk: 0,
      relayTotal: 0,
      verifiedStorageBytes: 0,
    };
    return {
      nodeId: nodeId as `0x${string}`,
      uptimeBps: ratioBps(item.uptimeOk, item.uptimeTotal),
      storageBps: ratioBps(item.storageOk, item.storageTotal),
      relayBps: ratioBps(item.relayOk, item.relayTotal),
      storageGb: bytesToGb(item.verifiedStorageBytes),
      uptimeSamples: item.uptimeTotal,
      storageSamples: item.storageTotal,
      relaySamples: item.relayTotal,
    };
  });
}

function buildRewardManifestForEpoch(epochId: number): RewardManifest {
  const stats = collectEpochStats(rewardTargets.nodeIds);
  const rewardPool = BigInt(config.rewardPoolWei ?? "1000000000000000000");
  const scoringResult = computeEpochRewards(rewardPool, stats);
  const rewardResult = buildRewardRoot(BigInt(epochId), scoringResult);
  const totalReward = Object.values(scoringResult.rewards).reduce((sum, amount) => sum + amount, 0n);

  return {
    epochId,
    rewardRoot: rewardResult.root,
    totalReward: totalReward.toString(),
    slashTotal: "0",
    treasuryDelta: scoringResult.treasuryOverflow.toString(),
    leaves: rewardResult.leaves.map((leaf) => ({ nodeId: leaf.nodeId, amount: leaf.amount.toString() })),
    proofs: Object.fromEntries(
      [...rewardResult.proofs.entries()].map(([key, proof]) => [key, proof as string[]]),
    ),
    scoringInputsHash: keccak256(toUtf8Bytes(stableStringifyForHash(stats))),
    generatedAtMs: Date.now(),
    challengerRewards: buildChallengerRewardsForEpoch(epochId),
    sourceNodeCount: rewardTargets.nodeIds.length,
    scoredNodeCount: stats.filter((stat) => stat.uptimeBps > 0 || stat.storageBps > 0 || stat.relayBps > 0).length,
    missingNodeIds: [...rewardTargets.missingEndpointNodeIds],
  };
}

async function persistRewardManifestForEpoch(epochId: number): Promise<RewardManifest> {
  const manifest = buildRewardManifestForEpoch(epochId);
  if (agentSignerV2) {
    try {
      const payload = manifestSigningPayload(manifest);
      manifest.generatorSignature = await agentSignerV2.eip712.signTypedData(REWARD_MANIFEST_TYPES, payload);
      manifest.generatorAddress = signer.address.toLowerCase();
    } catch (sigError) {
      log.warn("manifest signing failed (non-fatal)", { epochId, error: String(sigError) });
    }
  }
  try {
    writeRewardManifest(rewardManifestDir, manifest);
    log.info("reward manifest persisted", {
      epochId,
      rewardRoot: manifest.rewardRoot,
      totalReward: manifest.totalReward,
      leaves: manifest.leaves.length,
      sourceNodeCount: manifest.sourceNodeCount,
      missingNodeIds: manifest.missingNodeIds,
      signed: Boolean(manifest.generatorSignature),
    });
  } catch (manifestError) {
    log.error("reward manifest write failed (non-fatal)", { epochId, error: String(manifestError) });
  }
  return manifest;
}

function emitEpochScores(epochId: number): void {
  const stats = collectEpochStats(rewardTargets.nodeIds);
  const rewards = computeEpochRewards(BigInt(config.rewardPoolWei ?? "1000000000000000000"), stats);
  log.info("epoch rewards", {
    epochId,
    rewards: rewards.rewards,
    overflow: rewards.treasuryOverflow.toString(),
    capped: rewards.cappedNodes,
    sourceNodeCount: rewardTargets.nodeIds.length,
    missingNodeIds: rewardTargets.missingEndpointNodeIds,
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
    const manifest = await persistRewardManifestForEpoch(epochId);

    if (!poseContract) {
      log.info("batch(local)", {
        epochId,
        merkleRoot: batch.merkleRoot,
        summaryHash: batch.summaryHash,
        sampleProofs: batch.sampleProofs.length,
        rewardRoot: manifest.rewardRoot,
      });
      return true;
    }
    if (!canRunAggregatorRole(epochId)) {
      log.error("batch skipped: no aggregator permission for epoch", { epochId, receipts: receipts.length });
      return false;
    }

    const tx = await retryAsync(
      () => poseContract.submitBatch(BigInt(epochId), batch.merkleRoot, batch.summaryHash, batch.sampleProofs),
      txRetryOptions,
    );
    const receipt = await retryAsync(() => tx.wait(), txRetryOptions);

    try {
      const nodeId = keccak256(signer.signingKey.publicKey);
      const newCommitment = keccak256(toUtf8Bytes(`${nodeUrl}:${Date.now()}`));
      await retryAsync(() => poseContract.updateCommitment(nodeId, newCommitment), txRetryOptions);
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
      rewardRoot: manifest.rewardRoot,
    });
    return true;
  } catch (error) {
    log.error("batch failed", { error: String(error) });
    return false;
  }
}

async function refreshSelfNodeStatus(): Promise<void> {
  const statusContract = useV2 ? poseV2Contract : poseContract;
  if (!statusContract) {
    selfNodeRegistered = false;
    return;
  }
  try {
    const pubkey = signer.signingKey.publicKey;
    const nodeId = keccak256(pubkey);
    const node = await retryAsync(() => statusContract.getNode(nodeId), txRetryOptions);
    selfNodeRegistered = Boolean(node?.active);
  } catch {
    // keep previous value on failure
  }
}

async function refreshRewardTargets(epochId: number): Promise<void> {
  if (rewardTargets.epochId === epochId) {
    return;
  }

  const registerContract = useV2 ? poseV2Contract : poseContract;
  let nodeIds = [...trackedNodeIds];
  let source: RewardTargetSnapshot["source"] = "config";

  if (registerContract && typeof (registerContract as { queryFilter?: unknown }).queryFilter === "function") {
    try {
      const resolved = await retryAsync(
        () => listActiveNodeIds(registerContract as Parameters<typeof listActiveNodeIds>[0]),
        txRetryOptions,
      );
      nodeIds = resolved.map((nodeId) => nodeId.toLowerCase());
      source = "chain";
    } catch (error) {
      log.warn("reward target discovery from chain failed, fallback to configured nodeIds", {
        epochId,
        error: String(error),
      });
    }
  }

  // PoSe v2: chain-discovered nodeIds are keccak256(pubkey) (32-byte hash),
  // but agent.json's nodeEndpoints map is keyed by operator address (20-byte).
  // For each nodeId we don't already have, look up its pubkey on-chain, derive
  // the operator address, and copy the address-keyed URL into the map under
  // the 32-byte alias. This is one-shot per node and cached in the map.
  const getNode = (registerContract && typeof (registerContract as { getNode?: unknown }).getNode === "function")
    ? (registerContract as unknown as { getNode: (id: string) => Promise<{ pubkeyNode?: string }> }).getNode.bind(registerContract)
    : undefined;
  const { computeAddress } = await import("ethers");
  for (const nodeId of nodeIds) {
    const key = nodeId.toLowerCase();
    if (nodeEndpointMap.has(key)) continue;
    if (!getNode) continue;
    try {
      const record = await retryAsync(() => getNode(nodeId), txRetryOptions);
      const pk = record?.pubkeyNode;
      if (typeof pk !== "string" || !pk.startsWith("0x") || pk.length < 132) continue;
      const addr = computeAddress(pk).toLowerCase();
      const addrUrl = nodeEndpointMap.get(addr);
      if (addrUrl) {
        nodeEndpointMap.set(key, addrUrl);
        log.info("nodeEndpoint resolved via on-chain pubkey", { nodeId, addr });
      }
    } catch (err) {
      log.warn("nodeEndpoint on-chain pubkey lookup failed", { nodeId, error: String(err) });
    }
  }

  const missingEndpointNodeIds: string[] = [];
  const challengeableNodeIds: string[] = [];
  for (const nodeId of nodeIds) {
    if (resolveNodeEndpoint(nodeId, nodeIds.length)) {
      challengeableNodeIds.push(nodeId);
    } else {
      missingEndpointNodeIds.push(nodeId);
    }
  }

  rewardTargets = {
    epochId,
    nodeIds,
    challengeableNodeIds,
    missingEndpointNodeIds,
    source,
  };

  log.info("reward targets refreshed", {
    epochId,
    source,
    total: nodeIds.length,
    challengeable: challengeableNodeIds.length,
    missingEndpoints: missingEndpointNodeIds.length,
  });
  if (missingEndpointNodeIds.length > 0) {
    log.warn("reward targets missing endpoint mapping; reward settlement will be marked incomplete", {
      epochId,
      missing: missingEndpointNodeIds,
    });
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

function extractBatchIdV2(logs: Array<{ topics?: string[]; data?: string }>): string | null {
  if (!poseV2Contract) return null;
  for (const entry of logs) {
    try {
      const parsed = poseV2Contract.interface.parseLog(entry);
      if (parsed?.name === "BatchSubmittedV2") {
        return String(parsed.args.batchId ?? parsed.args[1]);
      }
    } catch {
      // ignore non-PoSe logs
    }
  }
  return null;
}

function persistV2FaultProofs(
  batchId: string,
  leafHashes: `0x${string}`[],
  receipts: VerifiedReceiptV2[],
): number {
  let queued = 0;
  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = receipts[i];
    const faultType = faultTypeForResultCode(receipt.evidenceLeaf.resultCode);
    if (faultType === 0) continue;

    const reasonCode =
      receipt.evidenceLeaf.resultCode === ResultCode.InvalidSig
        ? EvidenceReason.InvalidSignature
        : receipt.evidenceLeaf.resultCode === ResultCode.Timeout
          ? EvidenceReason.Timeout
          : EvidenceReason.StorageProofInvalid;
    const evidence: SlashEvidence = {
      nodeId: receipt.evidenceLeaf.nodeId,
      reasonCode,
      evidenceHash: leafHashes[i],
      rawEvidence: {
        protocolVersion: 2,
        batchId,
        merkleProof: buildMerkleProof(leafHashes, i),
        evidenceLeaf: serializeEvidenceLeaf(receipt.evidenceLeaf),
        evidenceLeafHash: leafHashes[i],
        challengeId: receipt.challenge.challengeId,
        faultType,
      },
    };
    evidenceStore.push(evidence);
    queued += 1;
  }
  return queued;
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

function resolveNodeEndpoint(nodeId: string, totalNodeCount = rewardTargets.nodeIds.length || trackedNodeIds.length): string | null {
  const mapped = nodeEndpointMap.get(nodeId.toLowerCase());
  if (mapped) return mapped;
  if (totalNodeCount === 1) return nodeUrl;
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

// Initialize the Phase C2.2 challenge-target source. Runs async but does
// not block the first tick — while the initial CidRegistry scan is in
// flight, pickStorageTarget sees `cidRegistryReader === null` and falls
// back to the legacy meta path. Once populated, subsequent ticks use
// the blockstore-backed target picker.
if (config.poseStorageFromBlockstore) {
  void initCidRegistryReader().catch((err) => {
    log.warn("CidRegistryReader init failed; falling back to legacy meta path", { error: String(err) });
  });
}

setInterval(() => void tick(), intervalMs);
void tick();

// Watchdog: force-release tickInProgress if a tick has been awaiting for
// longer than TICK_HANG_TIMEOUT_MS. Without this, a hung await inside the
// tick body (e.g. unresolved on-chain query during a chain stall, observed
// 3 times on 2026-04-26) leaves tickInProgress=true forever, causing every
// subsequent tick to skip silently with no path to recovery short of
// process restart.
setInterval(() => {
  if (tickInProgress && tickStartedAtMs > 0) {
    const elapsedMs = Date.now() - tickStartedAtMs;
    if (elapsedMs > TICK_HANG_TIMEOUT_MS) {
      log.error("tick watchdog: forcing release after hang", { elapsedMs });
      tickInProgress = false;
      tickStartedAtMs = 0;
    }
  }
}, 30_000);

async function initCidRegistryReader(): Promise<void> {
  const cidRegistryAddress = config.cidRegistryAddress;
  if (!cidRegistryAddress) {
    log.warn("poseStorageFromBlockstore enabled but cidRegistryAddress not configured, falling back to legacy");
    return;
  }
  // Minimal ABI: just the event we iterate.
  const CID_REGISTRY_ABI = [
    "event CidRegistered(bytes32 indexed cidHash, string cid, address indexed registrant)",
  ];
  const registry = new Contract(cidRegistryAddress, CID_REGISTRY_ABI, provider);
  const blockstore = new IpfsBlockstore(storageDir);

  // DHT proxy: call the node's `coc_dhtFindProviders` RPC so the agent
  // doesn't need its own peer table. nodeUrl is the local coc-node HTTP
  // endpoint; we reuse the existing requestJson helper for consistency
  // with the rest of the agent's node calls.
  // Default to the already-configured node URL so Docker-networked
  // agents reach node-1 by service name; falls back to localhost only
  // when neither env var nor config is set (bare-metal single-host dev).
  const rpcEndpoint = process.env.COC_RPC_URL ?? nodeUrl ?? "http://127.0.0.1:18780";
  const dhtProxy: DhtLike = {
    findProviders: async (cid: string, maxK = 3): Promise<string[]> => {
      try {
        const resp = await requestJson(rpcEndpoint, "POST", {
          jsonrpc: "2.0",
          id: 1,
          method: "coc_dhtFindProviders",
          params: [cid, maxK],
        });
        const raw = resp.json?.result?.providers;
        if (!Array.isArray(raw)) return [];
        return raw.filter((p: unknown): p is string => typeof p === "string");
      } catch (err) {
        log.debug("DHT proxy findProviders failed", { cid, error: String(err) });
        return [];
      }
    },
  };

  const reader = new CidRegistryReader({
    blockstore,
    dht: dhtProxy,
    contractReader: makeCidRegistryEventReader(
      registry as unknown as import("./lib/cid-registry-reader.ts").CidRegistryContractLike,
      { latestBlock: async () => Number(await provider.getBlockNumber()) },
    ),
  });
  await reader.refresh();
  cidRegistryReader = reader;
  log.info("CidRegistryReader initialized", { poolSize: reader.size() });

  // Phase C2.4 audit sampler — RPC-backed bytes fetch that bypasses
  // the prover. The node already knows the DHT provider set and its
  // wire connections; we just tell it the CID and who to exclude, and
  // it races whoever else is available. Any transport error collapses
  // into null, which the auditor treats as inconclusive.
  storageAuditDeps = {
    fetchChunkExcluding: async (cid: string, excludePeerId: string) => {
      try {
        const resp = await requestJson(rpcEndpoint, "POST", {
          jsonrpc: "2.0",
          id: 1,
          method: "coc_ipfsFetchBlockFromPeer",
          params: [cid, excludePeerId],
        });
        const raw = resp.json?.result?.bytes;
        return typeof raw === "string" && raw.length > 0 ? new Uint8Array(Buffer.from(raw, "base64")) : null;
      } catch {
        return null;
      }
    },
  };
  log.info("storage audit sampler initialized");
}
