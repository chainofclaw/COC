// r1-1-verify-wiring.mjs — Verify R1.1 wiring landed correctly on-chain.
//
// Reads each of the 4 wiring slots and asserts they point to the deployed
// addresses recorded in deployed-registries-newchain.json.

import { Contract, JsonRpcProvider } from "ethers"
import { readFile } from "node:fs/promises"

const RPC = "http://209.74.64.88:28780"
const REGISTRIES_PATH = "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json"
const ART_BASE = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance"

const reg = JSON.parse(await readFile(REGISTRIES_PATH, "utf-8"))
const provider = new JsonRpcProvider(RPC)

async function loadAbi(name) {
  return JSON.parse(await readFile(`${ART_BASE}/${name}.sol/${name}.json`, "utf-8")).abi
}

const validatorRegistryAbi = await loadAbi("ValidatorRegistry")
const govDaoAbi = await loadAbi("GovernanceDAO")
const insuranceFundAbi = await loadAbi("InsuranceFund")
const equivocationAbi = await loadAbi("EquivocationDetector")

const VR = new Contract(reg.contracts.ValidatorRegistry.address, validatorRegistryAbi, provider)
const DAO = new Contract(reg.contracts.GovernanceDAO.address, govDaoAbi, provider)
const IF = new Contract(reg.contracts.InsuranceFund.address, insuranceFundAbi, provider)
const ED = new Contract(reg.contracts.EquivocationDetector.address, equivocationAbi, provider)

console.log("==> Verifying R1.1 wiring on chainId 18780")
console.log()

const checks = [
  {
    label: "ValidatorRegistry.slasher == EquivocationDetector",
    actual: () => VR.slasher(),
    expected: reg.contracts.EquivocationDetector.address,
  },
  {
    label: "ValidatorRegistry.insuranceFund == InsuranceFund",
    actual: () => VR.insuranceFund(),
    expected: reg.contracts.InsuranceFund.address,
  },
  {
    label: "ValidatorRegistry.burnSink (storage default 0x0; runtime falls back to 0xdEaD per L288)",
    actual: () => VR.burnSink(),
    expected: "0x0000000000000000000000000000000000000000",
  },
  {
    label: "GovernanceDAO.treasury == Treasury",
    actual: () => DAO.treasury(),
    expected: reg.contracts.Treasury.address,
  },
  {
    label: "GovernanceDAO.factionRegistry == FactionRegistry",
    actual: () => DAO.factionRegistry(),
    expected: reg.contracts.FactionRegistry.address,
  },
  {
    label: "GovernanceDAO.owner == deployer",
    actual: () => DAO.owner(),
    expected: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  },
  {
    label: "InsuranceFund.governance == GovernanceDAO",
    actual: () => IF.governance(),
    expected: reg.contracts.GovernanceDAO.address,
  },
  {
    label: "EquivocationDetector.validatorRegistry == ValidatorRegistry",
    actual: () => ED.validatorRegistry(),
    expected: reg.contracts.ValidatorRegistry.address,
  },
  {
    label: "EquivocationDetector.owner == deployer",
    actual: () => ED.owner(),
    expected: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  },
]

let passed = 0
let failed = 0
for (const c of checks) {
  try {
    const actual = await c.actual()
    const ok = actual.toLowerCase() === c.expected.toLowerCase()
    if (ok) {
      console.log(`  ✅ ${c.label}`)
      console.log(`     ${actual}`)
      passed++
    } else {
      console.log(`  ❌ ${c.label}`)
      console.log(`     expected: ${c.expected}`)
      console.log(`     actual:   ${actual}`)
      failed++
    }
  } catch (err) {
    console.log(`  ⚠️  ${c.label}`)
    console.log(`     error: ${String(err).slice(0, 100)}`)
    failed++
  }
}

console.log(`\n==> ${passed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""}`)

// Bonus: confirm Treasury constants
const treasuryAbi = await loadAbi("Treasury")
const TR = new Contract(reg.contracts.Treasury.address, treasuryAbi, provider)
const required = await TR.REQUIRED_CONFIRMATIONS()
const govOnTreasury = await TR.governance()
console.log(`\n==> Treasury sanity:`)
console.log(`    REQUIRED_CONFIRMATIONS = ${required} (expect 3)`)
console.log(`    governance = ${govOnTreasury}`)
for (let i = 0; i < 5; i++) {
  const s = await TR.signers(i)
  console.log(`    signers[${i}] = ${s}`)
}

// ValidatorRegistry active set
const active = await VR.getActiveValidators()
console.log(`\n==> ValidatorRegistry active validators: ${active.length} (still 2 from P3-A)`)

if (failed > 0) process.exit(1)
console.log("\n==> R1.1 wiring verified end-to-end.")
