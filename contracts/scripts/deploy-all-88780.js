/**
 * Deploy ALL COC contracts to 88780 R3.2 testnet
 *
 * Run AFTER scripts/deploy-governance.js (which deploys FactionRegistry/DAO/Treasury).
 * Picks up existing governance addresses from env if provided.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   COC_RPC_URL=http://209.74.64.88:38780 \
 *   COC_CHAIN_ID=88780 \
 *   FACTION_REGISTRY=0x... GOVERNANCE_DAO=0x... TREASURY=0x... \
 *     npx hardhat run scripts/deploy-all-88780.js --network coc
 */

const { ethers } = require("hardhat")
const fs = require("fs")
const path = require("path")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  console.log("=== COC R3.2 88780 Full Contract Deploy ===")
  console.log(`Network:  ${network.name} (chainId: ${network.chainId})`)
  console.log(`Deployer: ${deployer.address}`)
  const bal = await ethers.provider.getBalance(deployer.address)
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH`)
  console.log("")

  const deployed = {
    network: "coc",
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {},
  }

  // Pre-existing governance from deploy-governance.js (if env set)
  if (process.env.FACTION_REGISTRY) deployed.contracts.FactionRegistry = process.env.FACTION_REGISTRY
  if (process.env.GOVERNANCE_DAO) deployed.contracts.GovernanceDAO = process.env.GOVERNANCE_DAO
  if (process.env.TREASURY) deployed.contracts.Treasury = process.env.TREASURY

  // Skip already-deployed contracts (if env addresses set, no need to redeploy)
  const skipExisting = process.env.SKIP_EXISTING === "1"
  if (skipExisting) {
    console.log("(SKIP_EXISTING=1: only deploying contracts missing from env)")
  }

  // 1. SoulRegistry (no constructor args)
  console.log("Deploying SoulRegistry...")
  const SoulRegistry = await ethers.getContractFactory("SoulRegistry")
  const soulRegistry = await SoulRegistry.deploy()
  await soulRegistry.waitForDeployment()
  deployed.contracts.SoulRegistry = await soulRegistry.getAddress()
  console.log(`  SoulRegistry: ${deployed.contracts.SoulRegistry}`)

  // 2. DIDRegistry (depends on SoulRegistry)
  console.log("Deploying DIDRegistry...")
  const DIDRegistry = await ethers.getContractFactory("DIDRegistry")
  const didRegistry = await DIDRegistry.deploy(deployed.contracts.SoulRegistry)
  await didRegistry.waitForDeployment()
  deployed.contracts.DIDRegistry = await didRegistry.getAddress()
  console.log(`  DIDRegistry:  ${deployed.contracts.DIDRegistry}`)

  // 3. CidRegistry (no constructor args)
  console.log("Deploying CidRegistry...")
  const CidRegistry = await ethers.getContractFactory("CidRegistry")
  const cidRegistry = await CidRegistry.deploy()
  await cidRegistry.waitForDeployment()
  deployed.contracts.CidRegistry = await cidRegistry.getAddress()
  console.log(`  CidRegistry:  ${deployed.contracts.CidRegistry}`)

  // 4. PoSeManager v1
  console.log("Deploying PoSeManager (v1)...")
  try {
    const PoSeManager = await ethers.getContractFactory("PoSeManager")
    const poseV1 = await PoSeManager.deploy()
    await poseV1.waitForDeployment()
    deployed.contracts.PoSeManager = await poseV1.getAddress()
    console.log(`  PoSeManager:  ${deployed.contracts.PoSeManager}`)
  } catch (e) {
    console.log(`  SKIPPED (constructor args mismatch): ${e.message.slice(0, 100)}`)
    deployed.contracts.PoSeManager = null
  }

  // 5. PoSeManager v2
  console.log("Deploying PoSeManagerV2...")
  try {
    const PoSeManagerV2 = await ethers.getContractFactory("PoSeManagerV2")
    const poseV2 = await PoSeManagerV2.deploy()
    await poseV2.waitForDeployment()
    deployed.contracts.PoSeManagerV2 = await poseV2.getAddress()
    console.log(`  PoSeManagerV2: ${deployed.contracts.PoSeManagerV2}`)
  } catch (e) {
    console.log(`  SKIPPED (constructor args mismatch): ${e.message.slice(0, 100)}`)
    deployed.contracts.PoSeManagerV2 = null
  }

  // 6. ValidatorRegistry (no args expected, on-chain validator stake registry)
  console.log("Deploying ValidatorRegistry...")
  try {
    const ValidatorRegistry = await ethers.getContractFactory("ValidatorRegistry")
    const vr = await ValidatorRegistry.deploy()
    await vr.waitForDeployment()
    deployed.contracts.ValidatorRegistry = await vr.getAddress()
    console.log(`  ValidatorRegistry: ${deployed.contracts.ValidatorRegistry}`)
  } catch (e) {
    console.log(`  SKIPPED: ${e.message.slice(0, 100)}`)
    deployed.contracts.ValidatorRegistry = null
  }

  // 7. EquivocationDetector (depends on ValidatorRegistry)
  console.log("Deploying EquivocationDetector...")
  try {
    const ED = await ethers.getContractFactory("EquivocationDetector")
    const ed = await ED.deploy(deployed.contracts.ValidatorRegistry)
    await ed.waitForDeployment()
    deployed.contracts.EquivocationDetector = await ed.getAddress()
    console.log(`  EquivocationDetector: ${deployed.contracts.EquivocationDetector}`)
  } catch (e) {
    console.log(`  SKIPPED: ${e.message.slice(0, 100)}`)
    deployed.contracts.EquivocationDetector = null
  }

  // 8. InsuranceFund (initial governance = GovernanceDAO)
  console.log("Deploying InsuranceFund...")
  try {
    const IF = await ethers.getContractFactory("InsuranceFund")
    const insurance = await IF.deploy(deployed.contracts.GovernanceDAO)
    await insurance.waitForDeployment()
    deployed.contracts.InsuranceFund = await insurance.getAddress()
    console.log(`  InsuranceFund: ${deployed.contracts.InsuranceFund}`)
  } catch (e) {
    console.log(`  SKIPPED: ${e.message.slice(0, 100)}`)
    deployed.contracts.InsuranceFund = null
  }

  // 9. DelayedInbox (rollup): (inclusionDelaySeconds, sequencerAddress)
  console.log("Deploying DelayedInbox...")
  try {
    const DI = await ethers.getContractFactory("DelayedInbox")
    // 24-hour inclusion delay, deployer as initial sequencer (testnet)
    const di = await DI.deploy(86400, deployer.address)
    await di.waitForDeployment()
    deployed.contracts.DelayedInbox = await di.getAddress()
    console.log(`  DelayedInbox: ${deployed.contracts.DelayedInbox}`)
  } catch (e) {
    console.log(`  SKIPPED: ${e.message.slice(0, 100)}`)
    deployed.contracts.DelayedInbox = null
  }

  // 10. RollupStateManager: (challengeWindowSeconds, proposerBondWei, challengerBondWei, insuranceFundAddress)
  console.log("Deploying RollupStateManager...")
  try {
    const RSM = await ethers.getContractFactory("RollupStateManager")
    // 24h challenge window, 1 ETH bonds (testnet), InsuranceFund as recipient
    const rsm = await RSM.deploy(
      86400,
      ethers.parseEther("1"),
      ethers.parseEther("1"),
      deployed.contracts.InsuranceFund || ethers.ZeroAddress,
    )
    await rsm.waitForDeployment()
    deployed.contracts.RollupStateManager = await rsm.getAddress()
    console.log(`  RollupStateManager: ${deployed.contracts.RollupStateManager}`)
  } catch (e) {
    console.log(`  SKIPPED: ${e.message.slice(0, 100)}`)
    deployed.contracts.RollupStateManager = null
  }

  // Write deployment manifest
  const outPath = path.join(__dirname, "..", "..", "configs", "deployed-contracts-88780.json")
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2))
  console.log("")
  console.log("=== Deployment Summary ===")
  console.log(JSON.stringify(deployed, null, 2))
  console.log(`\nManifest: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
