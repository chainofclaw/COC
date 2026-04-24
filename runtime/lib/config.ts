import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CocRuntimeConfig {
  dataDir: string;
  nodeBind?: string;
  nodePort?: number;
  nodeUrl?: string;
  nodeEndpoints?: Record<string, string>;
  storageDir?: string;
  agentIntervalMs?: number;
  agentBatchSize?: number;
  agentSampleSize?: number;
  relayerIntervalMs?: number;
  l1RpcUrl?: string;
  l2RpcUrl?: string;
  poseManagerAddress?: string;
  operatorPrivateKey?: string;
  operatorPrivateKeyFile?: string;
  pendingPath?: string;
  pendingV2Path?: string;
  pendingRetentionEpochs?: number;
  pendingArchivePath?: string;
  pendingV2ArchivePath?: string;
  agentMetricsPath?: string;
  agentMetricsPromPath?: string;
  agentMetricsBind?: string;
  agentMetricsPort?: number;
  agentMetricsIntervalMs?: number;
  tickOverlapLogIntervalMs?: number;
  nonceRegistryPath?: string;
  nonceRegistryTtlMs?: number;
  nonceRegistryMaxEntries?: number;
  challengerSet?: string[];
  aggregatorSet?: string[];
  nodeIds?: string[];
  rewardPoolWei?: string;
  slasherPrivateKey?: string;
  slasherPrivateKeyFile?: string;
  endpointFingerprintMode?: "strict" | "legacy";
  minBondWei?: string;
  txRetryAttempts?: number;
  txRetryBaseDelayMs?: number;
  txRetryMaxDelayMs?: number;
  nodeOpsPolicyPath?: string;
  nodeOpsHotReload?: boolean;
  nodeOpsAllowSelfRestart?: boolean;
  nodeOpsActionDir?: string;
  // v2 protocol config
  protocolVersion?: 1 | 2;
  chainId?: number;
  verifyingContract?: string;
  witnessNodes?: { url: string; witnessIndex: number }[];
  requiredWitnesses?: number;
  allowEmptyBatchWitnessSubmission?: boolean;
  tipToleranceBlocks?: number;
  challengeBondWei?: string;
  insuranceFundAddress?: string;
  poseManagerV2Address?: string;
  rewardManifestDir?: string;
  epochNonceStrict?: boolean;
  pendingChallengesPath?: string;
  /**
   * Phase C2.1 feature flag. When true, runtime/coc-node.ts's
   * `/pose/receipt` Storage handler derives Merkle proofs from the live
   * IPFS blockstore (reading real bytes via the C1.3 fetch-or-serve
   * path) instead of the pre-baked `file-meta.json`. Leave false until
   * C1 is deployed and soaked so a PoSe challenge against a CID not
   * locally pinned can actually fall through to a peer pull; otherwise
   * storage challenges against recently-uploaded-to-another-node CIDs
   * will all fail because we only trust blockstore.get at challenge
   * time.
   */
  poseStorageFromBlockstore?: boolean;
}

export function resolveDataDir(): string {
  const raw = process.env.COC_DATA_DIR || `${homedir()}/.clawdbot/coc`;
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

export async function loadConfig(): Promise<CocRuntimeConfig> {
  const dataDir = resolveDataDir();
  await mkdir(dataDir, { recursive: true });
  const configPath = process.env.COC_CONFIG || join(dataDir, "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return { dataDir, ...JSON.parse(raw) };
  } catch {
    return { dataDir };
  }
}

export async function writeConfig(config: CocRuntimeConfig): Promise<void> {
  const configPath = process.env.COC_CONFIG || join(resolveDataDir(), "config.json");
  await mkdir(resolveDataDir(), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}
