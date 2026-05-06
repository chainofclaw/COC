/**
 * DIDRegistry deployment script.
 * Deploys DIDRegistry to the target chain, referencing an existing SoulRegistry.
 */

import { ContractFactory, JsonRpcProvider, Wallet, parseUnits } from "ethers"
import type { TransactionReceipt } from "ethers"

export type DeployTarget = "l1-mainnet" | "l1-sepolia" | "l2-coc"

export interface DIDRegistryDeployParams {
  rpcUrl: string
  chainId: number
  confirmations: number
  gasStrategy: "legacy" | "eip1559"
  maxFeePerGasGwei?: number
  maxPriorityFeePerGasGwei?: number
}

export interface DeployResult {
  contractAddress: string
  transactionHash: string
  blockNumber: number
  chainId: number
  soulRegistryAddress: string
}

export function resolveDeployParams(target: DeployTarget): DIDRegistryDeployParams {
  switch (target) {
    case "l2-coc":
      return {
        rpcUrl: process.env.COC_RPC_URL ?? "http://127.0.0.1:18780",
        chainId: parseInt(process.env.COC_CHAIN_ID ?? "18780"),
        confirmations: 1,
        gasStrategy: "legacy",
      }
    case "l1-sepolia":
      return {
        rpcUrl: process.env.SEPOLIA_RPC_URL ?? "",
        chainId: 11155111,
        confirmations: 3,
        gasStrategy: "eip1559",
        maxFeePerGasGwei: 30,
        maxPriorityFeePerGasGwei: 2,
      }
    case "l1-mainnet":
      return {
        rpcUrl: process.env.MAINNET_RPC_URL ?? "",
        chainId: 1,
        confirmations: 5,
        gasStrategy: "eip1559",
        maxFeePerGasGwei: 50,
        maxPriorityFeePerGasGwei: 2,
      }
    default:
      throw new Error(`unknown deploy target: ${target}`)
  }
}

export async function deployDIDRegistry(
  target: DeployTarget,
  abi: object[],
  bytecode: string,
  soulRegistryAddress: string,
  privateKey?: string,
): Promise<DeployResult> {
  const params = resolveDeployParams(target)

  const pk = privateKey ?? process.env.DEPLOYER_PRIVATE_KEY
  if (!pk) {
    throw new Error("DEPLOYER_PRIVATE_KEY environment variable required")
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("Invalid private key format: expected 64 hex characters (with optional 0x prefix)")
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(soulRegistryAddress)) {
    throw new Error(`Invalid SoulRegistry address: ${soulRegistryAddress}`)
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
  // DIDRegistry constructor takes soulRegistryAddress as argument
  const contract = await factory.deploy(soulRegistryAddress, overrides)

  const receipt = await contract.deploymentTransaction()?.wait(params.confirmations) as TransactionReceipt | null
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Deployment transaction failed: ${receipt ? `status=${receipt.status}` : "no receipt"}`)
  }

  const contractAddress = await contract.getAddress()

  const code = await provider.getCode(contractAddress)
  if (!code || code === "0x") {
    throw new Error(`No contract code at ${contractAddress} after deployment`)
  }

  return {
    contractAddress,
    transactionHash: contract.deploymentTransaction()?.hash ?? "",
    blockNumber: receipt.blockNumber,
    chainId: params.chainId,
    soulRegistryAddress,
  }
}
