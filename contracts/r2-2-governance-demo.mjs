/**
 * R2.2 — GovernanceDAO + Treasury 双院制 demo (M8)
 *
 * Read-only inspection of the live governance suite on chainId 18780.
 * Proves contracts are wired and proposal lifecycle constants make sense.
 *
 * Reading order:
 *   1. FactionRegistry: ownership, verifier, registered count (best-effort)
 *   2. GovernanceDAO:   votingPeriod, timelockDelay, quorum/approval %, treasury
 *   3. Treasury:        DAO bond, balance
 *
 * A full proposal lifecycle (propose → vote 7d → queue → wait timelock 2d →
 * execute) is documented but not executed in this demo because the live
 * voting window is 7 days. For dev-fast lifecycle on chainId 88888 fork-off,
 * extend deploy-pose-on-h15.mjs with FactionRegistry/GovernanceDAO/Treasury
 * + setVotingPeriod(1 days) (the contract minimum).
 */

import { Contract, JsonRpcProvider, formatEther } from "ethers"
import { readFileSync } from "node:fs"

const RPC = process.env.RPC || "http://209.74.64.88:28780"
const REGISTRIES = "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json"

const FACTION_ABI = [
  "function owner() view returns (address)",
  "function verifier() view returns (address)",
  "function isRegistered(address) view returns (bool)",
  "function getFaction(address) view returns (uint8)",
]
const DAO_ABI = [
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
  "function votingPeriod() view returns (uint64)",
  "function timelockDelay() view returns (uint64)",
  "function quorumPercent() view returns (uint256)",
  "function approvalPercent() view returns (uint256)",
  "function bicameralEnabled() view returns (bool)",
  "function proposalCount() view returns (uint256)",
]
const TREASURY_ABI = [
  "function governance() view returns (address)",
  "function owner() view returns (address)",
  "function signers(uint256) view returns (address)",
  "function getBalance() view returns (uint256)",
]

const FACTION_NAMES = ["NONE", "HUMAN", "CLAW"]

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRIES, "utf-8"))
  const provider = new JsonRpcProvider(RPC)
  const head = await provider.getBlockNumber()
  console.log(`R2.2 governance demo (read-only) — chainId ${reg.chainId}, block ${head}`)
  console.log()

  // FactionRegistry
  const fr = new Contract(reg.contracts.FactionRegistry.address, FACTION_ABI, provider)
  console.log(`FactionRegistry @ ${reg.contracts.FactionRegistry.address}`)
  console.log(`  owner    = ${await fr.owner()}`)
  console.log(`  verifier = ${await fr.verifier()}`)
  const deployerFaction = await fr.getFaction(reg.deployer)
  const deployerReg = await fr.isRegistered(reg.deployer)
  console.log(`  deployer (${reg.deployer}): registered=${deployerReg}, faction=${FACTION_NAMES[Number(deployerFaction)]}`)
  console.log()

  // GovernanceDAO
  const dao = new Contract(reg.contracts.GovernanceDAO.address, DAO_ABI, provider)
  console.log(`GovernanceDAO @ ${reg.contracts.GovernanceDAO.address}`)
  console.log(`  owner            = ${await dao.owner()}`)
  console.log(`  treasury         = ${await dao.treasury()}`)
  const vp = await dao.votingPeriod()
  const td = await dao.timelockDelay()
  console.log(`  votingPeriod     = ${vp}s (${(Number(vp) / 86400).toFixed(2)}d)`)
  console.log(`  timelockDelay    = ${td}s (${(Number(td) / 86400).toFixed(2)}d)`)
  console.log(`  quorumPercent    = ${await dao.quorumPercent()}%`)
  console.log(`  approvalPercent  = ${await dao.approvalPercent()}%`)
  console.log(`  bicameralEnabled = ${await dao.bicameralEnabled()}`)
  console.log(`  proposalCount    = ${await dao.proposalCount()}`)
  console.log()

  // Treasury
  const tr = new Contract(reg.contracts.Treasury.address, TREASURY_ABI, provider)
  const treasuryBal = await provider.getBalance(reg.contracts.Treasury.address)
  console.log(`Treasury @ ${reg.contracts.Treasury.address}`)
  console.log(`  owner       = ${await tr.owner()}`)
  console.log(`  governance  = ${await tr.governance()}`)
  console.log(`  balance     = ${formatEther(treasuryBal)} ETH`)
  console.log(`  getBalance  = ${formatEther(await tr.getBalance())} ETH`)
  console.log()

  // Sanity assertions for "demo passes"
  const passed = []
  const failed = []
  const assertOk = (cond, msg) => cond ? passed.push(msg) : failed.push(msg)
  assertOk((await fr.owner()).toLowerCase() === reg.deployer.toLowerCase(),
    "FactionRegistry.owner == deployer")
  assertOk((await dao.owner()).toLowerCase() === reg.deployer.toLowerCase(),
    "GovernanceDAO.owner == deployer")
  assertOk((await dao.treasury()).toLowerCase() === reg.contracts.Treasury.address.toLowerCase(),
    "GovernanceDAO.treasury == Treasury")
  assertOk((await tr.governance()).toLowerCase() === reg.contracts.GovernanceDAO.address.toLowerCase(),
    "Treasury.governance == GovernanceDAO")
  assertOk(Number(vp) >= 86400 && Number(vp) <= 30 * 86400,
    "votingPeriod within [1d, 30d]")
  assertOk(Number(td) <= 14 * 86400,
    "timelockDelay <= 14d")

  console.log("=== Sanity ===")
  for (const p of passed) console.log(`  ok  ${p}`)
  for (const f of failed) console.log(`  FAIL ${f}`)
  console.log(`  ${passed.length}/${passed.length + failed.length} passed`)
  if (failed.length) process.exit(1)
}

main().catch((err) => { console.error("demo failed:", err); process.exit(1) })
