/**
 * Fork Choice Rule
 *
 * GHOST-inspired fork selection with BFT finality priority:
 * 1. BFT-finalized chain always wins
 * 2. Longer chain preferred
 * 3. Higher cumulative weight (stake) as tiebreaker
 * 4. Lower block hash as final tiebreaker (deterministic)
 */

import type { Hex } from "./blockchain-types.ts"

export interface ForkCandidate {
  /** Tip block height */
  height: bigint
  /** Tip block hash */
  tipHash: Hex
  /** Whether the chain has BFT finality */
  bftFinalized: boolean
  /** Cumulative stake-weight of the chain */
  cumulativeWeight: bigint
  /** Peer ID that advertises this chain */
  peerId: string
}

export type ForkReason = "bft-finality" | "longer-chain" | "higher-weight" | "lower-hash" | "equal"

export interface ForkChoice {
  winner: ForkCandidate
  loser: ForkCandidate
  reason: ForkReason
}

/**
 * Compare two fork candidates and determine the winner.
 */
export function compareForks(a: ForkCandidate, b: ForkCandidate): ForkChoice {
  // Rule 1: BFT finalized chain always wins
  if (a.bftFinalized && !b.bftFinalized) {
    return { winner: a, loser: b, reason: "bft-finality" }
  }
  if (b.bftFinalized && !a.bftFinalized) {
    return { winner: b, loser: a, reason: "bft-finality" }
  }

  // Rule 2: Longer chain preferred
  if (a.height > b.height) {
    return { winner: a, loser: b, reason: "longer-chain" }
  }
  if (b.height > a.height) {
    return { winner: b, loser: a, reason: "longer-chain" }
  }

  // Rule 3: Higher cumulative weight
  if (a.cumulativeWeight > b.cumulativeWeight) {
    return { winner: a, loser: b, reason: "higher-weight" }
  }
  if (b.cumulativeWeight > a.cumulativeWeight) {
    return { winner: b, loser: a, reason: "higher-weight" }
  }

  // Rule 4: Lower hash as deterministic tiebreaker
  if (a.tipHash < b.tipHash) {
    return { winner: a, loser: b, reason: "lower-hash" }
  }
  if (b.tipHash < a.tipHash) {
    return { winner: b, loser: a, reason: "lower-hash" }
  }

  return { winner: a, loser: b, reason: "equal" }
}

/**
 * Select the best chain from multiple candidates.
 */
export function selectBestFork(candidates: ForkCandidate[]): ForkCandidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  let best = candidates[0]
  for (let i = 1; i < candidates.length; i++) {
    const choice = compareForks(best, candidates[i])
    best = choice.winner
  }
  return best
}

/**
 * Determine if we should switch to a remote chain given our local state.
 * Returns the fork choice result, or null if no switch needed.
 */
export function shouldSwitchFork(
  local: ForkCandidate,
  remote: ForkCandidate,
): ForkChoice | null {
  const choice = compareForks(local, remote)
  if (choice.winner === remote && choice.reason !== "equal") {
    return choice
  }
  return null
}
