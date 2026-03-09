// Epoch timing helpers shared by relayer V1 and V2 paths.

const EPOCH_DURATION_MS = 60 * 60 * 1000 // 1 hour

export function currentEpochId(): number {
  return Math.floor(Date.now() / EPOCH_DURATION_MS)
}

export function resolveFinalizationCandidate(
  lastFinalizeEpoch: number,
  lagEpochs = 3,
): number | null {
  const candidate = currentEpochId() - lagEpochs
  if (candidate <= 0 || candidate <= lastFinalizeEpoch) return null
  return candidate
}
