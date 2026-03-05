// Witness collector for PoSe v2.
// Collects witness attestations from a set of witness nodes in parallel.

import type { Hex32 } from "../../services/common/pose-types.ts"
import type { WitnessAttestation } from "../../services/common/pose-types-v2.ts"
import { requestJson } from "./http-client.ts"

export interface WitnessCollectorConfig {
  witnessNodes: { url: string; witnessIndex: number }[]
  requiredWitnesses: number
  timeoutMs: number
}

export interface CollectResult {
  attestations: WitnessAttestation[]
  bitmap: number
  quorumMet: boolean
}

export interface BatchWitnessCollectResult {
  bitmap: number
  signatures: string[]
  signedCount: number
  requiredCount: number
  quorumMet: boolean
}

type WitnessRequestFn = (
  url: string,
  method: string,
  body?: unknown,
) => Promise<{ status?: number; json?: any }>

export async function collectWitnesses(
  config: WitnessCollectorConfig,
  challengeId: Hex32,
  nodeId: Hex32,
  responseBodyHash: Hex32,
): Promise<CollectResult> {
  const requests = config.witnessNodes.map(async (w) => {
    try {
      const response = await requestJson(`${w.url}/pose/witness`, "POST", {
        challengeId,
        nodeId,
        responseBodyHash,
        witnessIndex: w.witnessIndex,
      })
      return response.json as WitnessAttestation
    } catch {
      return null
    }
  })

  const results = await Promise.allSettled(requests)

  const attestations: WitnessAttestation[] = []
  let bitmap = 0

  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== null) {
      const attest = r.value
      if (
        attest.challengeId === challengeId &&
        attest.nodeId === nodeId &&
        attest.responseBodyHash === responseBodyHash &&
        attest.witnessIndex >= 0 &&
        attest.witnessIndex < 32
      ) {
        attestations.push(attest)
        bitmap |= (1 << attest.witnessIndex)
      }
    }
  }

  const witnessCount = popcount(bitmap)
  return {
    attestations,
    bitmap,
    quorumMet: witnessCount >= config.requiredWitnesses,
  }
}

export async function collectBatchWitnessSignatures(
  merkleRoot: Hex32,
  witnessSet: Hex32[],
  resolveEndpoint: (nodeId: Hex32, witnessIndex: number) => string | null,
  requestFn: WitnessRequestFn = requestJson,
): Promise<BatchWitnessCollectResult> {
  const normalizedRoot = merkleRoot.toLowerCase()
  const capped = witnessSet.slice(0, 32)
  const requiredCount = Math.floor((2 * capped.length + 2) / 3)
  if (capped.length === 0) {
    return { bitmap: 0, signatures: [], signedCount: 0, requiredCount, quorumMet: true }
  }

  const requests = capped.map(async (nodeId, witnessIndex) => {
    const url = resolveEndpoint(nodeId, witnessIndex)
    if (!url) return null
    try {
      const response = await requestFn(`${url}/pose/witness`, "POST", {
        challengeId: merkleRoot,
        nodeId,
        responseBodyHash: merkleRoot,
        witnessIndex,
      })
      const attest = response.json as Partial<WitnessAttestation> | undefined
      if (!attest) return null
      if (typeof attest.challengeId !== "string" || attest.challengeId.toLowerCase() !== normalizedRoot) return null
      if (typeof attest.nodeId !== "string" || attest.nodeId.toLowerCase() !== nodeId.toLowerCase()) return null
      if (typeof attest.responseBodyHash !== "string" || attest.responseBodyHash.toLowerCase() !== normalizedRoot) return null
      if (attest.witnessIndex !== witnessIndex) return null
      if (typeof attest.witnessSig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(attest.witnessSig)) return null
      return { witnessIndex, witnessSig: attest.witnessSig }
    } catch {
      return null
    }
  })

  const results = await Promise.allSettled(requests)
  let bitmap = 0
  const byIndex = new Map<number, string>()

  for (const r of results) {
    if (r.status !== "fulfilled" || r.value === null) continue
    const { witnessIndex, witnessSig } = r.value
    if (witnessIndex < 0 || witnessIndex >= 32) continue
    if (byIndex.has(witnessIndex)) continue
    byIndex.set(witnessIndex, witnessSig)
    bitmap |= (1 << witnessIndex)
  }

  const signatures: string[] = []
  for (let i = 0; i < capped.length; i++) {
    if (bitmap & (1 << i)) {
      const sig = byIndex.get(i)
      if (sig) signatures.push(sig)
    }
  }

  const signedCount = popcount(bitmap)
  return {
    bitmap,
    signatures,
    signedCount,
    requiredCount,
    quorumMet: signedCount >= requiredCount,
  }
}

function popcount(n: number): number {
  let count = 0
  let v = n
  while (v) {
    count += v & 1
    v >>>= 1
  }
  return count
}
