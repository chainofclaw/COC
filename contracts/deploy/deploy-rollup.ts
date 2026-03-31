/**
 * Deploy script for COC Optimistic Rollup contracts.
 *
 * Deploys RollupStateManager and DelayedInbox to the target network.
 *
 * Usage:
 *   node --experimental-strip-types contracts/deploy/deploy-rollup.ts [target]
 *
 * Targets: local, sepolia, mainnet
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY  — deployer wallet private key
 *   SEQUENCER_ADDRESS     — authorized sequencer address for DelayedInbox
 *   L1_RPC_URL            — override RPC URL
 *   INSURANCE_FUND_ADDRESS — insurance fund recipient
 */

import { JsonRpcProvider, Wallet, ContractFactory } from "ethers"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveRollupConfig, type RollupDeployTarget } from "./rollup-config.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface DeployResult {
  rollupStateManager: string
  delayedInbox: string
  network: string
  chainId: number
  deployer: string
}

function loadArtifact(contractName: string): { abi: object[]; bytecode: string } {
  const artifactPath = join(__dirname, "..", "artifacts", "contracts-src", "rollup", `${contractName}.sol`, `${contractName}.json`)
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"))
  return { abi: artifact.abi, bytecode: artifact.bytecode }
}

export async function deployRollupContracts(
  target: RollupDeployTarget,
  deployerKey?: string,
  sequencerAddress?: string,
): Promise<DeployResult> {
  const config = resolveRollupConfig(target)
  const pk = deployerKey ?? process.env.DEPLOYER_PRIVATE_KEY
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is required")

  const seqAddr = sequencerAddress ?? process.env.SEQUENCER_ADDRESS
  if (!seqAddr) throw new Error("SEQUENCER_ADDRESS is required")

  const provider = new JsonRpcProvider(config.rpcUrl)
  const deployer = new Wallet(pk, provider)

  console.log(`Deploying rollup contracts to ${target} (chainId ${config.chainId})`)
  console.log(`  Deployer: ${deployer.address}`)
  console.log(`  Sequencer: ${seqAddr}`)
  console.log(`  Challenge window: ${config.challengeWindowSeconds}s`)
  console.log(`  Proposer bond: ${config.proposerBondWei} wei`)
  console.log(`  Inclusion delay: ${config.inclusionDelaySeconds}s`)

  // Deploy RollupStateManager
  const rsmArtifact = loadArtifact("RollupStateManager")
  const rsmFactory = new ContractFactory(rsmArtifact.abi, rsmArtifact.bytecode, deployer)
  const rsm = await rsmFactory.deploy(
    config.challengeWindowSeconds,
    config.proposerBondWei,
    config.challengerBondWei,
    config.insuranceFundAddress,
  )
  await rsm.waitForDeployment()
  const rsmAddress = await rsm.getAddress()
  console.log(`  RollupStateManager deployed: ${rsmAddress}`)

  // Deploy DelayedInbox
  const diArtifact = loadArtifact("DelayedInbox")
  const diFactory = new ContractFactory(diArtifact.abi, diArtifact.bytecode, deployer)
  const di = await diFactory.deploy(config.inclusionDelaySeconds, seqAddr)
  await di.waitForDeployment()
  const diAddress = await di.getAddress()
  console.log(`  DelayedInbox deployed: ${diAddress}`)

  const result: DeployResult = {
    rollupStateManager: rsmAddress,
    delayedInbox: diAddress,
    network: target,
    chainId: config.chainId,
    deployer: deployer.address,
  }

  console.log("\nDeployment complete:")
  console.log(JSON.stringify(result, null, 2))

  return result
}

// ── CLI entry point ─────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("deploy-rollup.ts")
if (isMain) {
  const target = (process.argv[2] ?? "local") as RollupDeployTarget
  deployRollupContracts(target)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Deploy failed:", err)
      process.exit(1)
    })
}
