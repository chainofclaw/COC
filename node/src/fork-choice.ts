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

export type ForkReason = "bft-finality" | "longer-chain" | "higher-weight" | "lower-hash" | "lower-peer-id" | "equal"

export interface ForkChoice {
  winner: ForkCandidate
  loser: ForkCandidate
  reason: ForkReason
}

/**
 * Compare two fork candidates and determine the winner.
 *
 * PR-1P (#176, 2026-05-12): Rule 1 gates BFT-finality on `height >= other.height`.
 *
 * Pre-fix invariant was "BFT-finalized chain always wins". That broke
 * post-restart catch-up: trySync sets `remote.bftFinalized = false`
 * deliberately (peer's finality claim can't be trusted), so a node that
 * restarts holding a finalized tip at h=71813 would always beat any
 * peer's tip at h=71820+ via Rule 1 — even though the peers were ahead.
 * shouldSwitchFork returned null, the sync loop skipped the snapshot,
 * and the restarted node could never catch a small gap.
 *
 * Correct invariant: BFT finality protects the *prefix* (no reorg below
 * the finalized tip), not the *suffix*. A finalized tip at height H
 * does not justify rejecting peers at height > H — extending into
 * un-finalized territory is normal. So Rule 1 only fires when the
 * finalized side is also at-or-ahead. Below that, Rule 2 (longer
 * chain) takes over, which is the desired catch-up behaviour.
 */
export function compareForks(a: ForkCandidate, b: ForkCandidate): ForkChoice {
  // Rule 1: BFT-finalized chain wins — but only when it isn't strictly
  // shorter than the unfinalized alternative. See block doc above.
  if (a.bftFinalized && !b.bftFinalized && a.height >= b.height) {
    return { winner: a, loser: b, reason: "bft-finality" }
  }
  if (b.bftFinalized && !a.bftFinalized && b.height >= a.height) {
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

  // Rule 4: Lower hash as deterministic tiebreaker (case-normalized for consistency)
  const aHash = a.tipHash.toLowerCase()
  const bHash = b.tipHash.toLowerCase()
  if (aHash < bHash) {
    return { winner: a, loser: b, reason: "lower-hash" }
  }
  if (bHash < aHash) {
    return { winner: b, loser: a, reason: "lower-hash" }
  }

  // Rule 5: Lower peerId as final deterministic sub-tiebreaker
  // Ensures selectBestFork produces the same result regardless of candidate array order
  if (a.peerId < b.peerId) {
    return { winner: a, loser: b, reason: "lower-peer-id" }
  }
  if (b.peerId < a.peerId) {
    return { winner: b, loser: a, reason: "lower-peer-id" }
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
