/**
 * Rollup deployment configuration for COC Optimistic Rollup.
 *
 * Defines per-network parameters for RollupStateManager and DelayedInbox contracts.
 */

export interface RollupDeployConfig {
  readonly chainId: number
  readonly rpcUrl: string
  readonly challengeWindowSeconds: number
  readonly proposerBondWei: string
  readonly challengerBondWei: string
  readonly inclusionDelaySeconds: number
  readonly outputIntervalBlocks: number
  readonly insuranceFundAddress: string
  readonly confirmations: number
  readonly gasStrategy: "legacy" | "eip1559"
}

// ── Mainnet (Ethereum L1) ───────────────────────────────────────────────

export const ROLLUP_MAINNET: RollupDeployConfig = {
  chainId: 1,
  rpcUrl: process.env.L1_RPC_URL ?? "https://eth.llamarpc.com",
  challengeWindowSeconds: 604800,               // 7 days
  proposerBondWei: "1000000000000000000",        // 1 ETH
  challengerBondWei: "500000000000000000",       // 0.5 ETH
  inclusionDelaySeconds: 604800,                 // 7 days
  outputIntervalBlocks: 100,
  insuranceFundAddress: process.env.INSURANCE_FUND_ADDRESS ?? "0x0000000000000000000000000000000000000000",
  confirmations: 6,
  gasStrategy: "eip1559",
}

// ── Sepolia Testnet ─────────────────────────────────────────────────────

export const ROLLUP_SEPOLIA: RollupDeployConfig = {
  chainId: 11155111,
  rpcUrl: process.env.L1_RPC_URL ?? "https://rpc.sepolia.org",
  challengeWindowSeconds: 600,                   // 10 minutes (fast testing)
  proposerBondWei: "10000000000000000",          // 0.01 ETH
  challengerBondWei: "5000000000000000",         // 0.005 ETH
  inclusionDelaySeconds: 600,                    // 10 minutes
  outputIntervalBlocks: 10,
  insuranceFundAddress: process.env.INSURANCE_FUND_ADDRESS ?? "0x0000000000000000000000000000000000000000",
  confirmations: 2,
  gasStrategy: "eip1559",
}

// ── Local Devnet (Hardhat / COC node) ───────────────────────────────────

export const ROLLUP_LOCAL: RollupDeployConfig = {
  chainId: 18780,
  rpcUrl: process.env.COC_RPC_URL ?? "http://127.0.0.1:18780",
  challengeWindowSeconds: 60,                    // 1 minute (instant testing)
  proposerBondWei: "100000000000000000",         // 0.1 ETH
  challengerBondWei: "50000000000000000",        // 0.05 ETH
  inclusionDelaySeconds: 120,                    // 2 minutes
  outputIntervalBlocks: 5,
  insuranceFundAddress: "0x0000000000000000000000000000000000000000",
  confirmations: 1,
  gasStrategy: "legacy",
}

// ── Resolver ────────────────────────────────────────────────────────────

export type RollupDeployTarget = "mainnet" | "sepolia" | "local"

export function resolveRollupConfig(target: RollupDeployTarget): RollupDeployConfig {
  switch (target) {
    case "mainnet": return ROLLUP_MAINNET
    case "sepolia": return ROLLUP_SEPOLIA
    case "local":   return ROLLUP_LOCAL
    default:
      throw new Error(`unknown rollup deploy target: ${target}`)
  }
}
