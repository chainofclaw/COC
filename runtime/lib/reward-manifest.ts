// Reward manifest: shared data structure persisted by agent, consumed by relayer.
// Enables the authoritative reward pipeline: agent → file → relayer → contract.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"

export interface RewardLeafEntry {
  nodeId: string
  amount: string // stringified bigint
}

export interface RewardManifest {
  epochId: number
  rewardRoot: string
  totalReward: string // stringified bigint
  slashTotal: string
  treasuryDelta: string
  leaves: RewardLeafEntry[]
  proofs: Record<string, string[]> // key: "epochId:nodeId" → proof hashes
  scoringInputsHash: string
  generatedAtMs: number
}

export function stableStringifyForHash(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyForHash(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyForHash(obj[key])}`).join(",")}}`;
}

export function writeRewardManifest(dir: string, manifest: RewardManifest): string {
  mkdirSync(dir, { recursive: true })
  const filename = `reward-epoch-${manifest.epochId}.json`
  const path = `${dir}/${filename}`
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest, null, 2))
  renameSync(tmp, path)
  return path
}

export function readRewardManifest(dir: string, epochId: number): RewardManifest | null {
  const path = `${dir}/reward-epoch-${epochId}.json`
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    return JSON.parse(raw) as RewardManifest
  } catch {
    return null
  }
}

export function rewardManifestPath(dir: string, epochId: number): string {
  return `${dir}/reward-epoch-${epochId}.json`
}
