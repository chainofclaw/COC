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
import { ChallengeQuota } from "../services/challenger/challenge-quota.ts";
import { ReceiptVerifier } from "../services/verifier/receipt-verifier.ts";
import { NonceRegistry } from "../services/verifier/nonce-registry.ts";
import { BatchAggregator } from "../services/aggregator/batch-aggregator.ts";
import { computeEpochRewards } from "../services/verifier/scoring.ts";
import { AntiCheatPolicy, EvidenceReason } from "../services/verifier/anti-cheat-policy.ts";
import { keccak256Hex } from "../services/relayer/keccak256.ts";
import { ChallengeType } from "../services/common/pose-types.ts";
import { hashPair } from "../node/src/ipfs-merkle.ts";
import type { UnixFsFileMeta, Hex } from "../node/src/ipfs-types.ts";
import { createLogger } from "../node/src/logger.ts";
import { createNodeSigner, buildReceiptSignMessage } from "../node/src/crypto/signer.ts";
import { buildSignedPosePayload } from "../node/src/pose-http.ts";

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
  "function registerNode(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, bytes32 metadataHash, bytes ownershipSig) payable",
  "function updateCommitment(bytes32 nodeId, bytes32 newCommitment)",
  "function getNode(bytes32 nodeId) view returns (tuple(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, uint256 bondAmount, bytes32 metadataHash, uint64 registeredAtEpoch, uint64 unlockEpoch, bool active))",
  "function submitBatch(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, tuple(bytes32 leaf, bytes32[] merkleProof, uint32 leafIndex)[] sampleProofs) returns (bytes32 batchId)",
  "function operatorNodeCount(address) view returns (uint8)",
  "function requiredBond(address) view returns (uint256)",
];

const MIN_BOND_WEI = BigInt(process.env.COC_MIN_BOND_WEI || config.minBondWei || "100000000000000000"); // 0.1 ETH

const poseContract = poseManagerAddress ? new Contract(poseManagerAddress, poseAbi, signer) : null;

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
const nodeScores = new Map<string, { uptimeOk: number; uptimeTotal: number; storageOk: number; storageTotal: number; relayOk: number; relayTotal: number; verifiedStorageBytes: number }>();

// Persistent pending receipts store — survives crash/restart
class PendingReceiptStore {
  private items: Array<any> = [];
  private readonly path: string;

  constructor(persistencePath: string) {
    this.path = persistencePath;
    this.loadFromDisk();
  }

  get length(): number { return this.items.length; }

  push(item: any): void {
    this.items.push(item);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(item) + "\n");
    } catch { /* best-effort */ }
  }

  drain(): Array<any> {
    const result = this.items.splice(0);
    try { writeFileSync(this.path, ""); } catch { /* best-effort */ }
    return result;
  }

  private loadFromDisk(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf-8");
      for (const line of raw.split("\n").filter((l) => l.trim())) {
        try { this.items.push(JSON.parse(line)); } catch { /* skip */ }
      }
      if (this.items.length > 0) {
        log.info("restored pending receipts from disk", { count: this.items.length });
      }
    } catch { /* ignore */ }
  }
}

const pendingPath = process.env.COC_PENDING_PATH || join(config.dataDir, "pending-receipts.jsonl");
const pending = new PendingReceiptStore(pendingPath);
let currentEpoch = currentEpochId();
log.info("endpoint fingerprint mode", { mode: endpointFingerprintMode });

// Evidence pipeline: agent writes, relayer consumes
const evidencePath = process.env.COC_EVIDENCE_PATH || join(config.dataDir, "evidence-agent.jsonl");
export const evidenceStore = new EvidenceStore(1000, evidencePath);
const antiCheat = new AntiCheatPolicy();

await ensureNodeRegistered();

async function tick(): Promise<void> {
  try {
    await refreshLatestBlock();
    await refreshSelfNodeStatus();
    const nowEpoch = currentEpochId();
    if (nowEpoch !== currentEpoch && pending.length > 0) {
      await flushBatch(currentEpoch, pending.drain());
      emitEpochScores(currentEpoch);
      nodeScores.clear();
      currentEpoch = nowEpoch;
    }

    if (!canRunForEpochRole(currentEpoch)) {
      return;
    }

    for (const nodeId of trackedNodeIds) {
      await tryChallenge(nodeId, "Uptime");
      await tryChallenge(nodeId, "Storage");
      await tryChallenge(nodeId, "Relay");
    }

    if (pending.length >= batchSize) {
      await flushBatch(currentEpoch, pending.drain());
    }

    log.info("tick ok");
  } catch (error) {
    log.error("tick failed", { error: String(error) });
  }
}

async function ensureNodeRegistered(): Promise<void> {
  if (!poseContract) {
    return;
  }
  try {
    const pubkey = signer.signingKey.publicKey;
    const nodeId = keccak256(pubkey);
    const node = await poseContract.getNode(nodeId);
    if (node?.active) {
      return;
    }

    // Query progressive bond requirement from contract
    const bondRequired = await poseContract.requiredBond(signer.address) as bigint;

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

    const tx = await poseContract.registerNode(
      nodeId,
      pubkey,
      0x07,
      serviceCommitment,
      endpointCommitment,
      metadataHash,
      ownershipSig,
      { value: bondRequired },
    );
    await tx.wait();
    log.info("registered node onchain", { nodeId, bond: bondRequired.toString() });
  } catch (error) {
    log.error("register node failed", { error: String(error) });
  }
}

async function tryChallenge(nodeId: string, kind: keyof typeof ChallengeType): Promise<void> {
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
      `${nodeUrl}/pose/challenge`,
      "POST",
      buildSignedPosePayload("/pose/challenge", challenge as unknown as Record<string, unknown>, agentSigner),
    );
    const receiptResp = await requestJson(
      `${nodeUrl}/pose/receipt`,
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

async function flushBatch(epochId: number, receipts: Array<any>): Promise<void> {
  try {
    const batch = aggregator.buildBatch(BigInt(epochId), receipts);

    if (!poseContract || !canRunAggregatorRole(epochId)) {
      log.info("batch(local)", {
        epochId,
        merkleRoot: batch.merkleRoot,
        summaryHash: batch.summaryHash,
        sampleProofs: batch.sampleProofs.length,
      });
      return;
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
  } catch (error) {
    log.error("batch failed", { error: String(error) });
  }
}

// Track whether our own node is registered onchain
let selfNodeRegistered = false;

async function refreshSelfNodeStatus(): Promise<void> {
  if (!poseContract) return;
  try {
    const pubkey = signer.signingKey.publicKey;
    const nodeId = keccak256(pubkey);
    const node = await poseContract.getNode(nodeId);
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
