import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CocRuntimeConfig {
  dataDir: string;
  nodeBind?: string;
  nodePort?: number;
  nodeUrl?: string;
  storageDir?: string;
  agentIntervalMs?: number;
  agentBatchSize?: number;
  agentSampleSize?: number;
  relayerIntervalMs?: number;
  l1RpcUrl?: string;
  l2RpcUrl?: string;
  poseManagerAddress?: string;
  operatorPrivateKey?: string;
  nonceRegistryPath?: string;
  nonceRegistryTtlMs?: number;
  nonceRegistryMaxEntries?: number;
  challengerSet?: string[];
  aggregatorSet?: string[];
  nodeIds?: string[];
  rewardPoolWei?: string;
  slasherPrivateKey?: string;
  endpointFingerprintMode?: "strict" | "legacy";
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
