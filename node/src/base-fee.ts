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
const MIN_BASE_FEE = 1_000_000_000n // 1 gwei floor
export const BLOCK_GAS_LIMIT = 30_000_000n // 30M gas limit
const GAS_LIMIT = BLOCK_GAS_LIMIT

export interface BaseFeeParams {
  parentBaseFee: bigint
  parentGasUsed: bigint
  gasLimit?: bigint
}

export function calculateBaseFee(params: BaseFeeParams): bigint {
  const { parentBaseFee, parentGasUsed } = params
  const gasLimit = params.gasLimit ?? GAS_LIMIT
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
