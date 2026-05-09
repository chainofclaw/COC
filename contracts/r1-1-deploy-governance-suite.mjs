// r1-1-deploy-governance-suite.mjs — Plan §R1.1
// Deploy + wire 5 governance contracts on chainId 18780.
//
// Order (driven by constructor dependencies):
//   1. FactionRegistry()                           — no deps
//   2. GovernanceDAO(FactionRegistry)              — needs FactionRegistry
//   3. Treasury([5 signers], GovernanceDAO)        — needs GovernanceDAO
//   4. InsuranceFund(deployer)                     — initialGovernance = deployer (transfer to DAO later)
//   5. EquivocationDetector(ValidatorRegistry)     — needs ValidatorRegistry (already deployed)
//
// Wiring (after all deployed):
//   a. GovernanceDAO.setTreasury(Treasury)
//   b. ValidatorRegistry.setSlasher(EquivocationDetector)
//   c. ValidatorRegistry.setInsuranceFund(InsuranceFund)
//   d. InsuranceFund.transferGovernance(GovernanceDAO)
//
// PoSeManagerV2 has NO insuranceFund hook (verified by grep) — skip that step.
//
// Notes:
//   - 5 Treasury signers = anvil index 0..4 (well-known testnet keys).
//   - REQUIRED_CONFIRMATIONS = 3 hardcoded in the contract.
//   - GovernanceDAO.owner stays deployer until later DAO migration; setTreasury
//     requires owner permission so we need owner=deployer at wiring time.
//
// Output: appends new addresses to contracts/deployed-registries-newchain.json.

import { Contract, JsonRpcProvider, Wallet, ContractFactory, Transaction } from "ethers"
import { readFile, writeFile } from "node:fs/promises"

const RPC = "http://209.74.64.88:28780"   // upstream validator-1 (canonical)
const CHAIN_ID = 18780n
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  // anvil 0
const GAS_PRICE = 5_000_000_000n          // 5 gwei
const REGISTRIES_PATH = "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json"
const ARTIFACT_BASE = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance"
const VALIDATOR_REGISTRY_ARTIFACT = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"

const TREASURY_SIGNERS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",  // anvil 0 (deployer)
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",  // anvil 1
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",  // anvil 2
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",  // anvil 3
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",  // anvil 4
]

const provider = new JsonRpcProvider(RPC)
const deployer = new Wallet(DEPLOYER_KEY, provider)

async function loadArtifact(name) {
  const path = `${ARTIFACT_BASE}/${name}.sol/${name}.json`
  return JSON.parse(await readFile(path, "utf-8"))
}

async function deploy(name, args) {
  const art = await loadArtifact(name)
  const factory = new ContractFactory(art.abi, art.bytecode, deployer)
  const txReq = await factory.getDeployTransaction(...args)
  txReq.gasPrice = GAS_PRICE
  txReq.gasLimit = 5_000_000n
  txReq.type = 0
  txReq.chainId = CHAIN_ID
  txReq.nonce = await provider.getTransactionCount(deployer.address, "latest")
  const signed = await deployer.signTransaction(txReq)
  const parsed = Transaction.from(signed)
  await provider.broadcastTransaction(signed)
  console.log(`  deploy ${name} tx ${parsed.hash}`)
  const rcpt = await provider.waitForTransaction(parsed.hash, 1, 90_000)
  if (!rcpt || rcpt.status !== 1) throw new Error(`${name} deploy failed status=${rcpt?.status}`)
  console.log(`  ${name} -> ${rcpt.contractAddress} (block ${rcpt.blockNumber})`)
  return { address: rcpt.contractAddress, block: rcpt.blockNumber, txHash: parsed.hash }
}

async function callOwner(addr, abi, fnName, args) {
  const c = new Contract(addr, abi, deployer)
  const tx = await c[fnName](...args, { gasPrice: GAS_PRICE, gasLimit: 200_000n })
  console.log(`  ${fnName}(${args.map((a) => String(a).slice(0, 16)).join(", ")}) tx ${tx.hash}`)
  const rcpt = await tx.wait(1, 60_000)
  if (rcpt.status !== 1) throw new Error(`${fnName} failed`)
}

console.log("==> R1.1: Governance suite deployment")
console.log(`    RPC:      ${RPC}`)
console.log(`    chainId:  ${CHAIN_ID}`)
console.log(`    deployer: ${deployer.address}`)
const balance = await provider.getBalance(deployer.address)
console.log(`    balance:  ${(balance / 10n ** 18n).toString()} ETH`)
console.log()

// Load existing registry config to get ValidatorRegistry address + chain meta
const reg = JSON.parse(await readFile(REGISTRIES_PATH, "utf-8"))
const validatorRegistryAddr = reg.contracts.ValidatorRegistry.address
const poseManagerAddr = reg.contracts.PoSeManagerV2.address
console.log(`    ValidatorRegistry (existing): ${validatorRegistryAddr}`)
console.log(`    PoSeManagerV2     (existing): ${poseManagerAddr}`)
console.log()

// --- 1. FactionRegistry (no deps) -------------------------------------------
console.log("==> Step 1/5: FactionRegistry()")
const factionRegistry = await deploy("FactionRegistry", [])

// --- 2. GovernanceDAO(FactionRegistry) --------------------------------------
console.log("\n==> Step 2/5: GovernanceDAO(FactionRegistry)")
const governanceDao = await deploy("GovernanceDAO", [factionRegistry.address])

// --- 3. Treasury([5 signers], GovernanceDAO) --------------------------------
console.log("\n==> Step 3/5: Treasury(signers, GovernanceDAO)")
console.log(`    signers: ${TREASURY_SIGNERS.join(", ")}`)
const treasury = await deploy("Treasury", [TREASURY_SIGNERS, governanceDao.address])

// --- 4. InsuranceFund(deployer) ---------------------------------------------
console.log("\n==> Step 4/5: InsuranceFund(deployer)")
const insuranceFund = await deploy("InsuranceFund", [deployer.address])

// --- 5. EquivocationDetector(ValidatorRegistry) -----------------------------
console.log("\n==> Step 5/5: EquivocationDetector(ValidatorRegistry)")
const equivocationDetector = await deploy("EquivocationDetector", [validatorRegistryAddr])

// --- Wiring -----------------------------------------------------------------
console.log("\n==> Wiring contracts")

const validatorRegistryArt = JSON.parse(await readFile(VALIDATOR_REGISTRY_ARTIFACT, "utf-8"))
const govDaoArt = await loadArtifact("GovernanceDAO")
const insuranceFundArt = await loadArtifact("InsuranceFund")

console.log("  a. GovernanceDAO.setTreasury(Treasury)")
await callOwner(governanceDao.address, govDaoArt.abi, "setTreasury", [treasury.address])

console.log("  b. ValidatorRegistry.setSlasher(EquivocationDetector)")
await callOwner(validatorRegistryAddr, validatorRegistryArt.abi, "setSlasher", [equivocationDetector.address])

console.log("  c. ValidatorRegistry.setInsuranceFund(InsuranceFund)")
await callOwner(validatorRegistryAddr, validatorRegistryArt.abi, "setInsuranceFund", [insuranceFund.address])

console.log("  d. InsuranceFund.transferGovernance(GovernanceDAO)")
await callOwner(insuranceFund.address, insuranceFundArt.abi, "transferGovernance", [governanceDao.address])

// --- Persist to deployed-registries-newchain.json --------------------------
console.log("\n==> Updating deployed-registries-newchain.json")
const updatedAt = new Date().toISOString()
reg.note = `${reg.note ?? ""} | R1.1 governance suite added ${updatedAt.slice(0, 10)}`
reg.contracts.FactionRegistry = { address: factionRegistry.address, block: factionRegistry.block }
reg.contracts.GovernanceDAO = {
  address: governanceDao.address,
  block: governanceDao.block,
  deps: { factionRegistry: factionRegistry.address, treasury: treasury.address },
}
reg.contracts.Treasury = {
  address: treasury.address,
  block: treasury.block,
  signers: TREASURY_SIGNERS,
  requiredConfirmations: 3,
  governance: governanceDao.address,
}
reg.contracts.InsuranceFund = {
  address: insuranceFund.address,
  block: insuranceFund.block,
  governance: governanceDao.address,
}
reg.contracts.EquivocationDetector = {
  address: equivocationDetector.address,
  block: equivocationDetector.block,
  registry: validatorRegistryAddr,
}
reg.wiring = {
  ...(reg.wiring ?? {}),
  governanceSuiteWiredAt: updatedAt,
  validatorRegistry_slasher: equivocationDetector.address,
  validatorRegistry_insuranceFund: insuranceFund.address,
  governanceDao_treasury: treasury.address,
  insuranceFund_governance: governanceDao.address,
}

await writeFile(REGISTRIES_PATH, JSON.stringify(reg, null, 2) + "\n", "utf-8")
console.log("  registry config updated")

console.log("\n==> R1.1 complete. Summary:")
console.log(`    FactionRegistry:       ${factionRegistry.address}  (block ${factionRegistry.block})`)
console.log(`    GovernanceDAO:         ${governanceDao.address}    (block ${governanceDao.block})`)
console.log(`    Treasury:              ${treasury.address}         (block ${treasury.block})`)
console.log(`    InsuranceFund:         ${insuranceFund.address}    (block ${insuranceFund.block})`)
console.log(`    EquivocationDetector:  ${equivocationDetector.address}  (block ${equivocationDetector.block})`)
