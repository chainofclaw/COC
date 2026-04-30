/**
 * Phase I4 — PoSe relayer auto slashTotal computation
 *
 * Pure helpers that estimate the `slashTotal` accounting value the
 * relayer should pass to `PoSeManagerV2.finalizeEpochV2` for an epoch.
 *
 * Background: `slashTotal` is a declared accounting field stored in
 * `epochSlashTotal[epochId]`. The contract does NOT enforce it — actual
 * slashing happens later in `settleChallenge` per challenge, with the
 * 50/30/20 burn/challenger/insurance split. The relayer's responsibility
 * is to declare an honest expected total based on fault-confirmed
 * challenges visible at finalization time.
 *
 * The pure helpers in this file are framework-agnostic: callers feed in
 * already-fetched challenge + node records and get back the sum. The
 * actual RPC/event scan stays in `coc-relayer.ts` so this module is
 * unit-testable without mocking a Contract instance.
 */

/**
 * Match `PoSeManagerV2.SLASH_EPOCH_CAP_BPS` / `BPS_DENOMINATOR` constants.
 * Per-epoch maximum slash fraction of node bond. Stays here as the
 * canonical numeric for off-chain estimators; mirror in tests.
 */
export const SLASH_EPOCH_CAP_BPS = 1000n // 10% per the contract
export const BPS_DENOMINATOR = 10_000n

export interface FaultConfirmedChallenge {
  /** keccak256-derived nodeId from the contract's NodeRecord index */
  targetNodeId: string
  /** Per-node bond at the time of finalization; reads from `nodes(nodeId).bondAmount` */
  bondAmountWei: bigint
  /**
   * Already-slashed amount in this epoch for this nodeId. Populated from
   * `epochNodeSlashed[epoch][nodeId]`. The cap applies cumulatively, so
   * a second confirmed challenge in the same epoch eats from the
   * remainder of the same 10% bucket.
   */
  alreadySlashedThisEpochWei: bigint
}

/**
 * Compute the expected slashAmount for one fault-confirmed challenge,
 * matching the contract's settleChallenge logic but on a per-call basis.
 */
export function expectedSlashAmount(
  c: FaultConfirmedChallenge,
  options?: { capBps?: bigint; bpsDenominator?: bigint },
): bigint {
  const cap = options?.capBps ?? SLASH_EPOCH_CAP_BPS
  const denom = options?.bpsDenominator ?? BPS_DENOMINATOR

  if (c.bondAmountWei <= 0n) return 0n
  const maxSlash = (c.bondAmountWei * cap) / denom
  const remaining = maxSlash > c.alreadySlashedThisEpochWei
    ? maxSlash - c.alreadySlashedThisEpochWei
    : 0n
  // Real settle also clamps to bondAmount; mirror that.
  return remaining > c.bondAmountWei ? c.bondAmountWei : remaining
}

/**
 * Sum expected slash across a set of fault-confirmed challenges. Callers
 * pass the snapshot of confirmed challenges for a single epoch; the
 * result is the value to declare in `finalizeEpochV2.slashTotal`.
 *
 * Each challenge contributes its own expected slash, with cumulative
 * per-node tracking already encoded in `alreadySlashedThisEpochWei`.
 */
export function computeExpectedSlashTotal(
  challenges: FaultConfirmedChallenge[],
  options?: { capBps?: bigint; bpsDenominator?: bigint },
): bigint {
  // Accumulate, advancing alreadySlashed for the same nodeId so multiple
  // confirmed challenges hitting the same node share the cap honestly.
  const runningSlashed = new Map<string, bigint>()
  let total = 0n
  for (const c of challenges) {
    const lower = c.targetNodeId.toLowerCase()
    const already = runningSlashed.get(lower) ?? c.alreadySlashedThisEpochWei
    const slash = expectedSlashAmount(
      { ...c, alreadySlashedThisEpochWei: already },
      options,
    )
    total += slash
    runningSlashed.set(lower, already + slash)
  }
  return total
}
