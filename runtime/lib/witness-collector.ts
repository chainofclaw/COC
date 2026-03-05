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

function popcount(n: number): number {
  let count = 0
  let v = n
  while (v) {
    count += v & 1
    v >>>= 1
  }
  return count
}
