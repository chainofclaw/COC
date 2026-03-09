/**
 * V1 Epoch Finalizer — Challenger reward allocation logic.
 *
 * After epoch finalization, challengers who submitted valid batches
 * receive a proportional share of the reward pool.
 */

export interface SubmittedBatch {
  challenger: string
  challengeCount: number
  validReceiptCount: number
}

export interface ChallengerReward {
  challenger: string
  reward: bigint
}

/**
 * Allocate challenger rewards proportionally based on valid challenge count.
 *
 * @param batches   Submitted batches with challenge counts
 * @param rewardPool Total reward pool in wei
 * @param challengerShareBps Challenger share in basis points (default 500 = 5%)
 * @returns Map of challenger address → reward amount
 */
export function allocateChallengerRewards(
  batches: SubmittedBatch[],
  rewardPool: bigint,
  challengerShareBps = 500,
): Map<string, bigint> {
  const rewards = new Map<string, bigint>()

  if (batches.length === 0 || rewardPool <= 0n) return rewards

  // Calculate total challenger pool from rewardPool
  const challengerPool = (rewardPool * BigInt(challengerShareBps)) / 10000n
  if (challengerPool <= 0n) return rewards

  // Aggregate challenge counts per challenger
  const challengerTotals = new Map<string, number>()
  let totalChallenges = 0

  for (const batch of batches) {
    const current = challengerTotals.get(batch.challenger) ?? 0
    challengerTotals.set(batch.challenger, current + batch.challengeCount)
    totalChallenges += batch.challengeCount
  }

  if (totalChallenges === 0) return rewards

  // Distribute proportionally
  let distributed = 0n
  const entries = Array.from(challengerTotals.entries())

  for (let i = 0; i < entries.length; i++) {
    const [challenger, count] = entries[i]
    let reward: bigint

    if (i === entries.length - 1) {
      // Last challenger gets remainder to avoid rounding dust
      reward = challengerPool - distributed
    } else {
      reward = (challengerPool * BigInt(count)) / BigInt(totalChallenges)
    }

    if (reward > 0n) {
      rewards.set(challenger, reward)
      distributed += reward
    }
  }

  return rewards
}
