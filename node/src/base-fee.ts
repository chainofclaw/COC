/**
 * EIP-1559 Dynamic Base Fee Calculator
 *
 * Adjusts base fee per block based on gas utilization:
 * - Target utilization: 50% of gas limit
 * - Max change per block: 12.5% (1/8)
 * - If gas used > target: increase base fee
 * - If gas used < target: decrease base fee
 * - Floor: MIN_BASE_FEE (1 gwei)
 */

const TARGET_GAS_UTILIZATION = 50n // 50%
const MAX_CHANGE_DENOMINATOR = 8n  // 12.5% max change
export const MIN_BASE_FEE = 1_000_000_000n // 1 gwei floor
export const BLOCK_GAS_LIMIT = 30_000_000n // 30M gas limit
const GAS_LIMIT = BLOCK_GAS_LIMIT

export interface BaseFeeParams {
  parentBaseFee: bigint
  parentGasUsed: bigint
  gasLimit?: bigint
}

export function calculateBaseFee(params: BaseFeeParams): bigint {
  const { parentBaseFee } = params
  const gasLimit = params.gasLimit ?? GAS_LIMIT
  if (gasLimit <= 0n) return parentBaseFee
  // Clamp parentGasUsed to gasLimit to prevent base fee spike from corrupted storage
  const parentGasUsed = params.parentGasUsed > gasLimit ? gasLimit : params.parentGasUsed
  const targetGas = (gasLimit * TARGET_GAS_UTILIZATION) / 100n

  if (targetGas === 0n) return parentBaseFee

  if (parentGasUsed === targetGas) {
    return parentBaseFee
  }

  if (parentGasUsed > targetGas) {
    // Increase: baseFee += baseFee * (gasUsed - target) / target / MAX_CHANGE_DENOMINATOR
    const delta = parentGasUsed - targetGas
    const increase = (parentBaseFee * delta) / targetGas / MAX_CHANGE_DENOMINATOR
    // Ensure at least 1 wei increase when over target
    return parentBaseFee + (increase > 0n ? increase : 1n)
  }

  // Decrease: baseFee -= baseFee * (target - gasUsed) / target / MAX_CHANGE_DENOMINATOR
  const delta = targetGas - parentGasUsed
  const decrease = (parentBaseFee * delta) / targetGas / MAX_CHANGE_DENOMINATOR
  const newFee = parentBaseFee - decrease

  return newFee > MIN_BASE_FEE ? newFee : MIN_BASE_FEE
}

/**
 * Get the initial base fee for genesis/first block
 */
export function genesisBaseFee(): bigint {
  return MIN_BASE_FEE
}

// EIP-4844 Blob Gas constants
export const TARGET_BLOB_GAS_PER_BLOCK = 393_216n  // 3 blobs * 131072
export const MAX_BLOB_GAS_PER_BLOCK = 786_432n     // 6 blobs * 131072
const BLOB_GAS_PRICE_UPDATE_FRACTION = 3_338_477n
const MIN_BLOB_GAS_PRICE = 1n

/**
 * Calculate excess blob gas for the next block (EIP-4844).
 * excess = max(0, parentExcess + parentBlobGasUsed - TARGET)
 */
export function calculateExcessBlobGas(parentExcessBlobGas: bigint, parentBlobGasUsed: bigint): bigint {
  const total = parentExcessBlobGas + parentBlobGasUsed
  if (total < TARGET_BLOB_GAS_PER_BLOCK) return 0n
  return total - TARGET_BLOB_GAS_PER_BLOCK
}

/**
 * Compute blob gas price from excess blob gas using fake exponential (EIP-4844).
 * price = fakeExponential(MIN_BLOB_GAS_PRICE, excessBlobGas, BLOB_GAS_PRICE_UPDATE_FRACTION)
 */
export function computeBlobGasPrice(excessBlobGas: bigint): bigint {
  return fakeExponential(MIN_BLOB_GAS_PRICE, excessBlobGas, BLOB_GAS_PRICE_UPDATE_FRACTION)
}

/**
 * Fake exponential approximation from EIP-4844 spec.
 * Returns factor * e^(numerator/denominator) using Taylor series.
 */
function fakeExponential(factor: bigint, numerator: bigint, denominator: bigint): bigint {
  let i = 1n
  let output = 0n
  let acc = factor * denominator
  while (acc > 0n) {
    output += acc
    acc = (acc * numerator) / (denominator * i)
    i++
  }
  return output / denominator
}

/**
 * Phase I1 block-reward emission curve.
 *
 * Returns the wei reward to mint to the block proposer at a given height.
 * Geometric halving: reward halves every `halvingInterval` blocks.
 * height 0 (genesis) always returns 0.
 *
 * The TS-side hardcoded curve avoids per-block contract RPC roundtrips.
 * Governance can swap to an on-chain EmissionSchedule lookup later by
 * replacing the call site, but the consensus invariant (all nodes agree
 * on the reward) only holds when every node runs the same curve — so
 * mainnet rollout requires a coordinated upgrade, never a per-node env.
 */
export function getBlockReward(
  height: bigint,
  initialRewardWei: bigint,
  halvingInterval: bigint,
): bigint {
  if (height <= 0n) return 0n
  if (initialRewardWei <= 0n) return 0n
  if (halvingInterval <= 0n) return initialRewardWei

  const halvings = height / halvingInterval
  // Cap halvings to prevent emission running away into negative shifts.
  // After 64 halvings the reward is effectively dust; treat as zero.
  if (halvings >= 64n) return 0n

  return initialRewardWei >> halvings
}

/**
 * Default mainnet halving interval: ~4 years assuming 3s blocks.
 * 4 * 365.25 * 24 * 3600 / 3 ≈ 42_048_000 blocks.
 */
export const DEFAULT_HALVING_INTERVAL_BLOCKS = 42_048_000n
