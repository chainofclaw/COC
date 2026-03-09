/**
 * L1 (Mainnet / Testnet) deployment configuration for PoSe contracts.
 */

export interface L1DeployConfig {
  chainId: number
  rpcUrl: string
  gasStrategy: "legacy" | "eip1559"
  maxFeePerGasGwei?: number
  maxPriorityFeePerGasGwei?: number
  confirmations: number
  poseManagerArgs: {
    epochDurationMs: number
    slashBurnBps: number
    slashChallengerBps: number
    slashInsuranceBps: number
    perEpochSlashCapBps: number
    minStakeWei: string
  }
}

export const L1_MAINNET: L1DeployConfig = {
  chainId: 1,
  rpcUrl: process.env.L1_RPC_URL ?? "https://eth.llamarpc.com",
  gasStrategy: "eip1559",
  maxFeePerGasGwei: 50,
  maxPriorityFeePerGasGwei: 2,
  confirmations: 3,
  poseManagerArgs: {
    epochDurationMs: 3600_000, // 1 hour
    slashBurnBps: 5000,        // 50%
    slashChallengerBps: 3000,  // 30%
    slashInsuranceBps: 2000,   // 20%
    perEpochSlashCapBps: 500,  // 5%
    minStakeWei: "32000000000000000000", // 32 ETH
  },
}

export const L1_SEPOLIA: L1DeployConfig = {
  chainId: 11155111,
  rpcUrl: process.env.L1_RPC_URL ?? "https://rpc.sepolia.org",
  gasStrategy: "eip1559",
  maxFeePerGasGwei: 20,
  maxPriorityFeePerGasGwei: 1,
  confirmations: 2,
  poseManagerArgs: {
    epochDurationMs: 600_000, // 10 minutes
    slashBurnBps: 5000,
    slashChallengerBps: 3000,
    slashInsuranceBps: 2000,
    perEpochSlashCapBps: 500,
    minStakeWei: "1000000000000000000", // 1 ETH
  },
}

export function getL1Config(network: "mainnet" | "sepolia"): L1DeployConfig {
  return network === "mainnet" ? L1_MAINNET : L1_SEPOLIA
}
