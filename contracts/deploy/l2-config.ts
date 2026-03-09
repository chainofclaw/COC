/**
 * L2 (Rollup) deployment configuration for PoSe contracts.
 */

export interface L2DeployConfig {
  chainId: number
  rpcUrl: string
  gasStrategy: "legacy" | "eip1559"
  maxFeePerGasGwei?: number
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

export const L2_COC: L2DeployConfig = {
  chainId: 18780,
  rpcUrl: process.env.L2_RPC_URL ?? "http://127.0.0.1:18780",
  gasStrategy: "legacy",
  confirmations: 1,
  poseManagerArgs: {
    epochDurationMs: 3600_000,
    slashBurnBps: 5000,
    slashChallengerBps: 3000,
    slashInsuranceBps: 2000,
    perEpochSlashCapBps: 500,
    minStakeWei: "1000000000000000000", // 1 ETH
  },
}

export const L2_ARBITRUM: L2DeployConfig = {
  chainId: 42161,
  rpcUrl: process.env.L2_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
  gasStrategy: "eip1559",
  maxFeePerGasGwei: 1,
  confirmations: 1,
  poseManagerArgs: {
    epochDurationMs: 3600_000,
    slashBurnBps: 5000,
    slashChallengerBps: 3000,
    slashInsuranceBps: 2000,
    perEpochSlashCapBps: 500,
    minStakeWei: "1000000000000000000",
  },
}

export const L2_OPTIMISM: L2DeployConfig = {
  chainId: 10,
  rpcUrl: process.env.L2_RPC_URL ?? "https://mainnet.optimism.io",
  gasStrategy: "eip1559",
  maxFeePerGasGwei: 1,
  confirmations: 1,
  poseManagerArgs: {
    epochDurationMs: 3600_000,
    slashBurnBps: 5000,
    slashChallengerBps: 3000,
    slashInsuranceBps: 2000,
    perEpochSlashCapBps: 500,
    minStakeWei: "1000000000000000000",
  },
}

export function getL2Config(network: "coc" | "arbitrum" | "optimism"): L2DeployConfig {
  switch (network) {
    case "coc": return L2_COC
    case "arbitrum": return L2_ARBITRUM
    case "optimism": return L2_OPTIMISM
  }
}
