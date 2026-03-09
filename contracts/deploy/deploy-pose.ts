/**
 * Unified PoSe contract deployment script.
 * Reads L1/L2 config and deploys PoSeManagerV2 with correct parameters.
 */

import { ContractFactory, JsonRpcProvider, Wallet, parseUnits } from "ethers"
import type { TransactionReceipt } from "ethers"
import { getL1Config, type L1DeployConfig } from "./l1-config.ts"
import { getL2Config, type L2DeployConfig } from "./l2-config.ts"

export type DeployTarget = "l1-mainnet" | "l1-sepolia" | "l2-coc" | "l2-arbitrum" | "l2-optimism"

export interface DeployParams {
  rpcUrl: string
  chainId: number
  confirmations: number
  gasStrategy: "legacy" | "eip1559"
  maxFeePerGasGwei?: number
  maxPriorityFeePerGasGwei?: number
  epochDurationMs: number
  slashBurnBps: number
  slashChallengerBps: number
  slashInsuranceBps: number
  perEpochSlashCapBps: number
  minStakeWei: string
}

/**
 * Resolve deployment parameters from a target identifier.
 */
export function resolveDeployParams(target: DeployTarget): DeployParams {
  let config: L1DeployConfig | L2DeployConfig

  switch (target) {
    case "l1-mainnet":
      config = getL1Config("mainnet")
      break
    case "l1-sepolia":
      config = getL1Config("sepolia")
      break
    case "l2-coc":
      config = getL2Config("coc")
      break
    case "l2-arbitrum":
      config = getL2Config("arbitrum")
      break
    case "l2-optimism":
      config = getL2Config("optimism")
      break
    default:
      throw new Error(`unknown deploy target: ${target}`)
  }

  return {
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    confirmations: config.confirmations,
    gasStrategy: config.gasStrategy,
    maxFeePerGasGwei: config.maxFeePerGasGwei,
    maxPriorityFeePerGasGwei: "maxPriorityFeePerGasGwei" in config
      ? config.maxPriorityFeePerGasGwei
      : undefined,
    ...config.poseManagerArgs,
  }
}

/**
 * Validate deployment parameters.
 * Returns array of error messages (empty = valid).
 */
export function validateDeployParams(params: DeployParams): string[] {
  const errors: string[] = []

  if (params.chainId < 1) errors.push("chainId must be positive")
  if (params.confirmations < 1) errors.push("confirmations must be >= 1")
  if (params.epochDurationMs < 60_000) errors.push("epochDurationMs must be >= 60000")

  const totalSlashBps = params.slashBurnBps + params.slashChallengerBps + params.slashInsuranceBps
  if (totalSlashBps !== 10000) {
    errors.push(`slash distribution must sum to 10000 bps, got ${totalSlashBps}`)
  }

  if (params.perEpochSlashCapBps > 10000) {
    errors.push("perEpochSlashCapBps must be <= 10000")
  }

  try {
    const stake = BigInt(params.minStakeWei)
    if (stake <= 0n) errors.push("minStakeWei must be positive")
  } catch {
    errors.push("minStakeWei must be a valid integer string")
  }

  return errors
}

export interface DeployResult {
  contractAddress: string
  transactionHash: string
  blockNumber: number
  chainId: number
}

/**
 * Deploy PoSeManagerV2 to the target chain.
 * Requires DEPLOYER_PRIVATE_KEY environment variable.
 */
export async function deployPoSeManagerV2(
  target: DeployTarget,
  abi: object[],
  bytecode: string,
  privateKey?: string,
): Promise<DeployResult> {
  const params = resolveDeployParams(target)
  const errors = validateDeployParams(params)
  if (errors.length > 0) {
    throw new Error(`invalid deploy params: ${errors.join(", ")}`)
  }

  const pk = privateKey ?? process.env.DEPLOYER_PRIVATE_KEY
  if (!pk) {
    throw new Error("DEPLOYER_PRIVATE_KEY environment variable required")
  }

  const provider = new JsonRpcProvider(params.rpcUrl)
  const deployer = new Wallet(pk, provider)

  const overrides: Record<string, unknown> = {}
  if (params.gasStrategy === "eip1559" && params.maxFeePerGasGwei) {
    overrides.maxFeePerGas = parseUnits(String(params.maxFeePerGasGwei), "gwei")
    if (params.maxPriorityFeePerGasGwei) {
      overrides.maxPriorityFeePerGas = parseUnits(String(params.maxPriorityFeePerGasGwei), "gwei")
    }
  }

  const factory = new ContractFactory(abi, bytecode, deployer)
  const contract = await factory.deploy(
    BigInt(params.epochDurationMs),
    BigInt(params.slashBurnBps),
    BigInt(params.slashChallengerBps),
    BigInt(params.slashInsuranceBps),
    BigInt(params.perEpochSlashCapBps),
    BigInt(params.minStakeWei),
    overrides,
  )

  const receipt = await contract.deploymentTransaction()?.wait(params.confirmations) as TransactionReceipt | null
  const contractAddress = await contract.getAddress()

  return {
    contractAddress,
    transactionHash: contract.deploymentTransaction()?.hash ?? "",
    blockNumber: receipt?.blockNumber ?? 0,
    chainId: params.chainId,
  }
}
