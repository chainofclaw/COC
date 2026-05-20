/**
 * Deploy ALL COC contracts to 88780 R3.2 testnet (UUPS proxies — gen-5)
 *
 * Run AFTER scripts/deploy-governance.js (which deploys FactionRegistry/DAO/
 * Treasury proxies). Picks up existing governance addresses from env if
 * provided.
 *
 * Every contract goes up behind a UUPS proxy via @openzeppelin/hardhat-upgrades.
 * Implementations are constructor-locked; the proxy runs `initialize(...)`
 * once at deploy.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x...  (non-public — preflight enforces)
 *   COC_RPC_URL=http://209.74.64.88:38780
 *   COC_CHAIN_ID=88780
 *   MULTISIG_ADDRESS=0x...
 *   FACTION_REGISTRY=0x... GOVERNANCE_DAO=0x... TREASURY=0x...
 *     npx hardhat run scripts/deploy-all-88780.js --network coc
 */

const { ethers, upgrades } = require("hardhat")
const fs = require("fs")
const path = require("path")
const { assertSafeDeployer, transferOwnershipChecked } = require("./preflight.js")

async function deployProxy(factoryName, args) {
  const Factory = await ethers.getContractFactory(factoryName)
  const proxy = await upgrades.deployProxy(Factory, args, {
    initializer: "initialize",
    kind: "uups",
  })
  await proxy.waitForDeployment()
  return proxy
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  // #686: refuse to deploy from a public Hardhat test account.
  assertSafeDeployer(deployer.address)
  // #683: address seeded into the RollupStateManager proposer allowlist.
  const outputProposer = process.env.OUTPUT_PROPOSER_ADDRESS || ethers.ZeroAddress

  console.log("=== COC R3.2 88780 Full Contract Deploy (UUPS gen-5) ===")
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

  // Pre-existing governance proxies from deploy-governance.js (if env set)
  if (process.env.FACTION_REGISTRY) deployed.contracts.FactionRegistry = process.env.FACTION_REGISTRY
  if (process.env.GOVERNANCE_DAO) deployed.contracts.GovernanceDAO = process.env.GOVERNANCE_DAO
  if (process.env.TREASURY) deployed.contracts.Treasury = process.env.TREASURY

  // 1. SoulRegistry — initialize(initialOwner)
  console.log("Deploying SoulRegistry proxy...")
  const soulRegistry = await deployProxy("SoulRegistry", [deployer.address])
  deployed.contracts.SoulRegistry = await soulRegistry.getAddress()
  console.log(`  SoulRegistry: ${deployed.contracts.SoulRegistry}`)

  // 2. DIDRegistry — initialize(_soulRegistry, initialOwner)
  console.log("Deploying DIDRegistry proxy...")
  const didRegistry = await deployProxy("DIDRegistry", [
    deployed.contracts.SoulRegistry,
    deployer.address,
  ])
  deployed.contracts.DIDRegistry = await didRegistry.getAddress()
  console.log(`  DIDRegistry:  ${deployed.contracts.DIDRegistry}`)

  // 3. CidRegistry — initialize(initialOwner)
  console.log("Deploying CidRegistry proxy...")
  const cidRegistry = await deployProxy("CidRegistry", [deployer.address])
  deployed.contracts.CidRegistry = await cidRegistry.getAddress()
  console.log(`  CidRegistry:  ${deployed.contracts.CidRegistry}`)

  // 4. PoSeManager v1 — initialize(initialOwner)
  console.log("Deploying PoSeManager (v1) proxy...")
  const poseV1 = await deployProxy("PoSeManager", [deployer.address])
  deployed.contracts.PoSeManager = await poseV1.getAddress()
  console.log(`  PoSeManager:  ${deployed.contracts.PoSeManager}`)

  // 5. PoSeManagerV2 — initialize(challengeBondMin, initialOwner)
  //    Proxy address auto-fills DOMAIN_SEPARATOR via address(this) inside
  //    the initializer; no separate post-deploy initialize step needed (#685).
  console.log("Deploying PoSeManagerV2 proxy...")
  const challengeBondMin = process.env.POSE_CHALLENGE_BOND_MIN
    ? BigInt(process.env.POSE_CHALLENGE_BOND_MIN)
    : ethers.parseEther("0.1")
  const poseV2 = await deployProxy("PoSeManagerV2", [challengeBondMin, deployer.address])
  deployed.contracts.PoSeManagerV2 = await poseV2.getAddress()
  console.log(`  PoSeManagerV2: ${deployed.contracts.PoSeManagerV2} (initialized; bondMin=${challengeBondMin})`)

  // 6. ValidatorRegistry — initialize(initialOwner, initialSlasher, initialSlashRecipient)
  console.log("Deploying ValidatorRegistry proxy...")
  const vr = await deployProxy("ValidatorRegistry", [
    deployer.address,
    deployer.address,
    deployer.address,
  ])
  deployed.contracts.ValidatorRegistry = await vr.getAddress()
  console.log(`  ValidatorRegistry: ${deployed.contracts.ValidatorRegistry}`)

  // 7. EquivocationDetector — initialize(validatorRegistry, initialOwner)
  console.log("Deploying EquivocationDetector proxy...")
  const ed = await deployProxy("EquivocationDetector", [
    deployed.contracts.ValidatorRegistry,
    deployer.address,
  ])
  deployed.contracts.EquivocationDetector = await ed.getAddress()
  console.log(`  EquivocationDetector: ${deployed.contracts.EquivocationDetector}`)

  // 8. InsuranceFund — initialize(governance, initialOwner)
  console.log("Deploying InsuranceFund proxy...")
  const insurance = await deployProxy("InsuranceFund", [
    deployed.contracts.GovernanceDAO,
    deployer.address,
  ])
  deployed.contracts.InsuranceFund = await insurance.getAddress()
  console.log(`  InsuranceFund: ${deployed.contracts.InsuranceFund}`)

  // 9. DelayedInbox — initialize(inclusionDelaySeconds, sequencer, initialOwner)
  console.log("Deploying DelayedInbox proxy...")
  const di = await deployProxy("DelayedInbox", [
    86400, // 24h inclusion delay
    deployer.address, // initial sequencer (testnet)
    deployer.address,
  ])
  deployed.contracts.DelayedInbox = await di.getAddress()
  console.log(`  DelayedInbox: ${deployed.contracts.DelayedInbox}`)

  // 10. RollupStateManager — initialize(challengeWindow, proposerBond, challengerBond, insuranceFund, initialProposer, initialOwner)
  console.log("Deploying RollupStateManager proxy...")
  const rsm = await deployProxy("RollupStateManager", [
    86400, // 24h challenge window
    ethers.parseEther("1"), // proposer bond
    ethers.parseEther("1"), // challenger bond
    deployed.contracts.InsuranceFund || ethers.ZeroAddress,
    outputProposer,
    deployer.address,
  ])
  deployed.contracts.RollupStateManager = await rsm.getAddress()
  console.log(`  RollupStateManager: ${deployed.contracts.RollupStateManager}`)

  // --- #686: hand contract ownership to the multisig ---
  const multisig = process.env.MULTISIG_ADDRESS
  if (multisig) {
    console.log("")
    console.log(`Transferring ownership to multisig ${multisig}...`)
    const OWNABLE = [
      "FactionRegistry",
      "GovernanceDAO",
      "Treasury",
      "SoulRegistry",
      "DIDRegistry",
      "CidRegistry",
      "PoSeManager",
      "PoSeManagerV2",
      "ValidatorRegistry",
      "EquivocationDetector",
      "InsuranceFund",
      "DelayedInbox",
      "RollupStateManager",
    ]
    for (const name of OWNABLE) {
      const addr = deployed.contracts[name]
      if (!addr) {
        console.log(`  ${name}: SKIPPED (not deployed)`)
        continue
      }
      const c = await ethers.getContractAt(name, addr)
      await transferOwnershipChecked(c, name, multisig)
    }
    deployed.owner = multisig
    console.log("Ownership handoff complete — all 13 proxies' owner == multisig.")
    console.log("Upgrade authority for every proxy is now the 3-of-5 multisig (#686 resolved).")
  } else {
    deployed.owner = deployer.address
    console.log("")
    console.log("WARNING: MULTISIG_ADDRESS not set — proxies remain owned by the")
    console.log("         deployer. #686 is NOT resolved until ownership is moved")
    console.log("         to a multisig.")
  }

  // Write deployment manifest (records proxy addresses; the OZ upgrades plugin
  // stores implementation addresses + storage-layout hashes in
  // contracts/.openzeppelin/<network>.json — commit that file too).
  const outPath = path.join(__dirname, "..", "..", "configs", "deployed-contracts-88780.json")
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2))
  console.log("")
  console.log("=== Deployment Summary ===")
  console.log(JSON.stringify(deployed, null, 2))
  console.log(`\nManifest: ${outPath}`)
  console.log("\nDon't forget to commit `contracts/.openzeppelin/coc-88780.json` —")
  console.log("the OZ upgrades plugin needs it to validate storage layout on future")
  console.log("upgradeProxy() calls. Losing it loses the safety check.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
