/**
 * Deploy Governance Contracts (UUPS proxies — gen-5)
 *
 * Deploys FactionRegistry, GovernanceDAO, and Treasury as OpenZeppelin UUPS
 * proxies. Each implementation is locked via _disableInitializers and the
 * proxy runs the contract's `initialize(...)` exactly once.
 *
 * Usage:
 *   MULTISIG_ADDRESS=0x...   # optional; if set, ownership of every proxy is
 *                              transferred to it as the final step of the
 *                              cross-script flow (see deploy-all-88780.js).
 *   npx hardhat run scripts/deploy-governance.js --network <network>
 *
 * Environment:
 *   INITIAL_VOTING_PERIOD  - Voting period in seconds (default: 259200 = 3 days)
 *   INITIAL_TIMELOCK_DELAY - Timelock delay in seconds (default: 86400 = 1 day)
 *   INITIAL_QUORUM_PERCENT - Quorum percentage (default: 40)
 *   INITIAL_APPROVAL_PERCENT - Approval threshold (default: 60)
 *   TREASURY_SIGNERS       - Comma-separated; exactly 5 addresses (default: 88780 validators)
 */

const { ethers, upgrades } = require("hardhat")
const { assertSafeDeployer } = require("./preflight.js")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  // #686: refuse to deploy from a public Hardhat test account.
  assertSafeDeployer(deployer.address)

  console.log("=== COC Governance Deployment (UUPS) ===")
  console.log(`Network:  ${network.name} (chainId: ${network.chainId})`)
  console.log(`Deployer: ${deployer.address}`)
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`)
  console.log("")

  // 1. Deploy FactionRegistry behind a UUPS proxy.
  //    initialize(initialOwner, initialVerifier) — owner stays deployer until
  //    deploy-all-88780.js does the final transferOwnership(multisig).
  console.log("Deploying FactionRegistry proxy...")
  const FactionRegistry = await ethers.getContractFactory("FactionRegistry")
  const factionRegistry = await upgrades.deployProxy(
    FactionRegistry,
    [deployer.address, deployer.address],
    { initializer: "initialize", kind: "uups" },
  )
  await factionRegistry.waitForDeployment()
  const factionAddr = await factionRegistry.getAddress()
  console.log(`  FactionRegistry: ${factionAddr}`)

  // 2. Deploy GovernanceDAO behind a UUPS proxy.
  //    initialize(_factionRegistry, initialOwner). Default governance params
  //    (votingPeriod=7d, timelockDelay=2d, quorum=40%, approval=60%) are set
  //    inside the initializer; we override them below via owner setters.
  console.log("Deploying GovernanceDAO proxy...")
  const GovernanceDAO = await ethers.getContractFactory("GovernanceDAO")
  const governanceDAO = await upgrades.deployProxy(
    GovernanceDAO,
    [factionAddr, deployer.address],
    { initializer: "initialize", kind: "uups" },
  )
  await governanceDAO.waitForDeployment()
  const daoAddr = await governanceDAO.getAddress()
  console.log(`  GovernanceDAO:   ${daoAddr}`)

  // 3. Deploy Treasury behind a UUPS proxy.
  //    initialize(address[5] _signers, address _governance, address initialOwner).
  console.log("Deploying Treasury proxy...")
  const DEFAULT_TREASURY_SIGNERS = [
    "0xde4e7889aa9007318ff261b1ee675f1305153590",
    "0xb939e5a68abd2e000e78876bd86edd1cbba49eb9",
    "0xdefc8430388093fdfacb0a929fedc14d2e631d19",
    "0xcc64096600c1759d7aaea91166837a5873175867",
    "0x5e773c9359a6bb416bdfffe0c9aac9f568bd11ae",
  ]
  const treasurySigners = process.env.TREASURY_SIGNERS
    ? process.env.TREASURY_SIGNERS.split(",").map((s) => s.trim())
    : DEFAULT_TREASURY_SIGNERS
  if (treasurySigners.length !== 5) {
    throw new Error(`Treasury requires exactly 5 signers, got ${treasurySigners.length}`)
  }
  const Treasury = await ethers.getContractFactory("Treasury")
  const treasury = await upgrades.deployProxy(
    Treasury,
    [treasurySigners, daoAddr, deployer.address],
    { initializer: "initialize", kind: "uups" },
  )
  await treasury.waitForDeployment()
  const treasuryAddr = await treasury.getAddress()
  console.log(`  Treasury:        ${treasuryAddr}`)

  // 4. Wire contracts together
  console.log("")
  console.log("Wiring contracts...")
  const tx = await governanceDAO.setTreasury(treasuryAddr)
  await tx.wait()
  console.log("  GovernanceDAO.setTreasury() done")

  // 5. Set initial governance parameters (only the deployer can while still owner).
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
