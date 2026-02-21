import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "./paths.ts";

export interface CocRuntimeConfig {
  nodeBind?: string;
  nodePort?: number;
  nodeUrl?: string;
  agentIntervalMs?: number;
  agentBatchSize?: number;
  agentSampleSize?: number;
  relayerIntervalMs?: number;
  l1RpcUrl?: string;
  l2RpcUrl?: string;
}

export function resolveConfigPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "config.json");
}

export async function readRuntimeConfig(dataDir?: string): Promise<CocRuntimeConfig> {
  const dir = resolveDataDir(dataDir);
  await mkdir(dir, { recursive: true });
  try {
    const raw = await readFile(resolveConfigPath(dataDir), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeRuntimeConfig(dataDir: string | undefined, config: CocRuntimeConfig): Promise<void> {
  const dir = resolveDataDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(resolveConfigPath(dataDir), JSON.stringify(config, null, 2));
}
