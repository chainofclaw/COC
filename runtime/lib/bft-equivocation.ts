import type { SlashEvidence } from "../../services/verifier/anti-cheat-policy.ts"

export interface EquivocationEvidence {
  validatorId: string
  height: bigint
  phase?: string
  round?: number
  vote1Hash: string
  vote2Hash: string
  timestamp: number
  /**
   * #725: the two BFT signatures over the conflicting vote hashes.
   * When present, the relayer can submit them to the on-chain
   * EquivocationDetector for permissionless slashing. Optional
   * because legacy / round-only evidence may omit them.
   */
  signature1?: string
  signature2?: string
}

export function normalizeEquivocationRpcEntry(entry: Record<string, unknown>): EquivocationEvidence | null {
  const validatorId = typeof entry.validatorId === "string" ? entry.validatorId : ""
  const vote1Hash = typeof entry.vote1Hash === "string" ? entry.vote1Hash : ""
  const vote2Hash = typeof entry.vote2Hash === "string" ? entry.vote2Hash : ""
  if (!validatorId || !vote1Hash || !vote2Hash) {
    return null
  }

  const heightValue = entry.height
  let height = 0n
  try {
    height = BigInt(String(heightValue ?? 0))
  } catch {
    return null
  }

  const roundValue = entry.round
  const round =
    typeof roundValue === "number" && Number.isFinite(roundValue)
      ? roundValue
      : typeof roundValue === "string" && roundValue.length > 0 && Number.isFinite(Number(roundValue))
        ? Number(roundValue)
        : undefined
  const phase = typeof entry.phase === "string" && entry.phase.length > 0 ? entry.phase : undefined
  const timestampValue = entry.timestamp
  const timestamp =
    typeof timestampValue === "number" && Number.isFinite(timestampValue)
      ? timestampValue
      : typeof timestampValue === "string" && timestampValue.length > 0 && Number.isFinite(Number(timestampValue))
        ? Number(timestampValue)
      : Date.now()

  // #725: extract the BFT signatures so downstream callers can submit the
  // evidence to the on-chain EquivocationDetector.
  const sig1 = typeof entry.signature1 === "string" && entry.signature1.length > 0
    ? entry.signature1 : undefined
  const sig2 = typeof entry.signature2 === "string" && entry.signature2.length > 0
    ? entry.signature2 : undefined

  return {
    validatorId,
    height,
    phase,
    round,
    vote1Hash,
    vote2Hash,
    timestamp,
    ...(sig1 ? { signature1: sig1 } : {}),
    ...(sig2 ? { signature2: sig2 } : {}),
  }
}

export function buildBftEquivocationSlashEvidence(evidence: EquivocationEvidence): SlashEvidence {
  const location = evidence.phase
    ? `phase ${evidence.phase}`
    : typeof evidence.round === "number"
      ? `round ${evidence.round}`
      : "unknown phase"

  return {
    offender: evidence.validatorId,
    reason: `BFT equivocation at height ${evidence.height}, ${location}`,
    severity: "critical",
    timestamp: evidence.timestamp,
    rawEvidence: {
      protocolVersion: 2,
      faultType: "equivocation",
      vote1Hash: evidence.vote1Hash,
      vote2Hash: evidence.vote2Hash,
      height: evidence.height.toString(),
      ...(evidence.phase ? { phase: evidence.phase } : {}),
      ...(typeof evidence.round === "number" ? { round: evidence.round } : {}),
    },
  }
}
