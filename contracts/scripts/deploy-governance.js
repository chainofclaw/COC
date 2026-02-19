/**
 * Deploy Governance Contracts
 *
 * Deploys FactionRegistry, GovernanceDAO, and Treasury to the target network.
 * Wires contracts together and outputs deployed addresses.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-governance.js --network <network>
 *
 * Environment:
 *   INITIAL_VOTING_PERIOD  - Voting period in seconds (default: 259200 = 3 days)
 *   INITIAL_TIMELOCK_DELAY - Timelock delay in seconds (default: 86400 = 1 day)
 *   INITIAL_QUORUM_PERCENT - Quorum percentage (default: 40)
 *   INITIAL_APPROVAL_PERCENT - Approval threshold (default: 60)
 */

const { ethers } = require("hardhat")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  console.log("=== COC Governance Deployment ===")
  console.log(`Network:  ${network.name} (chainId: ${network.chainId})`)
  console.log(`Deployer: ${deployer.address}`)
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`)
  console.log("")

  // 1. Deploy FactionRegistry
  console.log("Deploying FactionRegistry...")
  const FactionRegistry = await ethers.getContractFactory("FactionRegistry")
  const factionRegistry = await FactionRegistry.deploy()
  await factionRegistry.waitForDeployment()
  const factionAddr = await factionRegistry.getAddress()
  console.log(`  FactionRegistry: ${factionAddr}`)

  // 2. Deploy GovernanceDAO
  console.log("Deploying GovernanceDAO...")
  const GovernanceDAO = await ethers.getContractFactory("GovernanceDAO")
  const governanceDAO = await GovernanceDAO.deploy(factionAddr)
  await governanceDAO.waitForDeployment()
  const daoAddr = await governanceDAO.getAddress()
  console.log(`  GovernanceDAO:   ${daoAddr}`)

  // 3. Deploy Treasury
  console.log("Deploying Treasury...")
  const Treasury = await ethers.getContractFactory("Treasury")
  const treasury = await Treasury.deploy(daoAddr)
  await treasury.waitForDeployment()
  const treasuryAddr = await treasury.getAddress()
  console.log(`  Treasury:        ${treasuryAddr}`)

  // 4. Wire contracts together
  console.log("")
  console.log("Wiring contracts...")
  const tx = await governanceDAO.setTreasury(treasuryAddr)
  await tx.wait()
  console.log("  GovernanceDAO.setTreasury() done")

  // 5. Set initial governance parameters
  const votingPeriod = parseInt(process.env.INITIAL_VOTING_PERIOD || "259200") // 3 days
  const timelockDelay = parseInt(process.env.INITIAL_TIMELOCK_DELAY || "86400") // 1 day
  const quorumPercent = parseInt(process.env.INITIAL_QUORUM_PERCENT || "40")
  const approvalPercent = parseInt(process.env.INITIAL_APPROVAL_PERCENT || "60")

  console.log("")
  console.log("Setting governance parameters...")

  const tx1 = await governanceDAO.setVotingPeriod(votingPeriod)
  await tx1.wait()
  console.log(`  Voting period:     ${votingPeriod}s (${votingPeriod / 86400} days)`)

  const tx2 = await governanceDAO.setTimelockDelay(timelockDelay)
  await tx2.wait()
  console.log(`  Timelock delay:    ${timelockDelay}s (${timelockDelay / 86400} days)`)

  const tx3 = await governanceDAO.setQuorumPercent(quorumPercent)
  await tx3.wait()
  console.log(`  Quorum:            ${quorumPercent}%`)

  const tx4 = await governanceDAO.setApprovalPercent(approvalPercent)
  await tx4.wait()
  console.log(`  Approval:          ${approvalPercent}%`)

  // 6. Verify deployment
  console.log("")
  console.log("Verifying deployment...")
  const regOwner = await factionRegistry.owner()
  const daoOwner = await governanceDAO.owner()
  const treasuryOwner = await treasury.owner()
  const daoTreasury = await governanceDAO.treasury()
  const treasuryGov = await treasury.governance()

  const checks = [
    { name: "FactionRegistry.owner", expected: deployer.address, actual: regOwner },
    { name: "GovernanceDAO.owner", expected: deployer.address, actual: daoOwner },
    { name: "Treasury.owner", expected: deployer.address, actual: treasuryOwner },
    { name: "GovernanceDAO.treasury", expected: treasuryAddr, actual: daoTreasury },
    { name: "Treasury.governance", expected: daoAddr, actual: treasuryGov },
  ]

  let allOk = true
  for (const check of checks) {
    const ok = check.expected.toLowerCase() === check.actual.toLowerCase()
    console.log(`  ${ok ? "OK" : "FAIL"}: ${check.name}`)
    if (!ok) {
      console.log(`    Expected: ${check.expected}`)
      console.log(`    Actual:   ${check.actual}`)
      allOk = false
    }
  }

  if (!allOk) {
    console.error("\nDeployment verification FAILED!")
    process.exit(1)
  }

  // 7. Output summary
  console.log("")
  console.log("=== Deployment Summary ===")
  console.log(JSON.stringify({
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    contracts: {
      FactionRegistry: factionAddr,
      GovernanceDAO: daoAddr,
      Treasury: treasuryAddr,
    },
    parameters: {
      votingPeriod,
      timelockDelay,
      quorumPercent,
      approvalPercent,
      bicameralEnabled: false,
    },
  }, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
