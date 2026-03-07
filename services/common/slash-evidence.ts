import { join } from "node:path"
import { keccak256Hex } from "../relayer/keccak256.ts"
import type { Hex32 } from "./pose-types.ts"

export const DEFAULT_EVIDENCE_FILENAME = "evidence.jsonl"
export const LEGACY_AGENT_EVIDENCE_FILENAME = "evidence-agent.jsonl"
export const LEGACY_BFT_EVIDENCE_FILENAME = "evidence-bft.jsonl"

export interface EvidencePathSet {
  writePath: string
  readPaths: string[]
}

export function resolveEvidencePaths(dataDir: string, explicitPath?: string): EvidencePathSet {
  if (explicitPath) {
    return { writePath: explicitPath, readPaths: [explicitPath] }
  }

  const shared = join(dataDir, DEFAULT_EVIDENCE_FILENAME)
  const legacyAgent = join(dataDir, LEGACY_AGENT_EVIDENCE_FILENAME)
  const legacyBft = join(dataDir, LEGACY_BFT_EVIDENCE_FILENAME)
  return {
    writePath: shared,
    readPaths: [shared, legacyAgent, legacyBft],
  }
}

export function encodeSlashEvidencePayload(
  nodeId: Hex32,
  rawEvidence: Record<string, unknown>,
): Uint8Array {
  const challengeId = extractEvidenceChallengeId(rawEvidence)
  const challengeIdBytes = hex32ToBytes(challengeId)
  const nodeIdBytes = hex32ToBytes(nodeId)
  const jsonTail = Buffer.from(stableStringifyEvidence(rawEvidence), "utf8")
  return Buffer.concat([challengeIdBytes, nodeIdBytes, jsonTail])
}

export function hashSlashEvidencePayload(
  nodeId: Hex32,
  rawEvidence: Record<string, unknown>,
): Hex32 {
  return `0x${keccak256Hex(encodeSlashEvidencePayload(nodeId, rawEvidence))}` as Hex32
}

export function extractEvidenceChallengeId(rawEvidence: Record<string, unknown>): Hex32 {
  const candidate = rawEvidence.challengeId
  if (typeof candidate === "string" && /^0x[0-9a-fA-F]{64}$/.test(candidate)) {
    return candidate.toLowerCase() as Hex32
  }
  return `0x${"0".repeat(64)}` as Hex32
}

export function stableStringifyEvidence(value: unknown): string {
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyEvidence(item)).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyEvidence(obj[key])}`).join(",")}}`
}

function hex32ToBytes(value: Hex32): Buffer {
  return Buffer.from(value.slice(2), "hex")
}
