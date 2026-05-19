/**
 * Standalone redeploy of PoSeManagerV2 to 88780.
 *
 * PoSeManagerV2 has no constructor args and zero on-chain dependents, so a
 * standalone redeploy does not cascade stale cross-references.
 *
 * Unlike earlier revisions this script also:
 *   - refuses public Hardhat test accounts as deployer (#686)
 *   - calls initialize() right after deploy so DOMAIN_SEPARATOR /
 *     challengeBondMin are non-zero (#685)
 *   - hands ownership to MULTISIG_ADDRESS when set (#686)
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY    — securely-held deployer key
 *   POSE_CHALLENGE_BOND_MIN — challenge bond minimum in wei (default 0.1 ETH)
 *   MULTISIG_ADDRESS        — multisig that should own the contract
 */
const { ethers } = require("hardhat")
const { assertSafeDeployer, transferOwnershipChecked } = require("./preflight.js")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  // #686: refuse to deploy from a public Hardhat test account.
  assertSafeDeployer(deployer.address)

  console.log(`Network:  chainId ${network.chainId}`)
  console.log(`Deployer: ${deployer.address}`)
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`)
  console.log(`Nonce:    ${await ethers.provider.getTransactionCount(deployer.address)}`)
  console.log("")

  console.log("Deploying PoSeManagerV2 (no constructor args)...")
  const PoSeManagerV2 = await ethers.getContractFactory("PoSeManagerV2")
  const poseV2 = await PoSeManagerV2.deploy()
  await poseV2.waitForDeployment()
  const addr = await poseV2.getAddress()
  console.log(`  PoSeManagerV2: ${addr}`)

  // #685: initialize immediately so DOMAIN_SEPARATOR / challengeBondMin are
  // non-zero. verifyingContract is the contract's own address — the off-chain
  // witness signers (runtime/coc-node.ts) build the EIP-712 domain from it too.
  const challengeBondMin = process.env.POSE_CHALLENGE_BOND_MIN
    ? BigInt(process.env.POSE_CHALLENGE_BOND_MIN)
    : ethers.parseEther("0.1")
  const initTx = await poseV2.initialize(network.chainId, addr, challengeBondMin)
  await initTx.wait()
  console.log(`  PoSeManagerV2.initialize() done (challengeBondMin=${challengeBondMin})`)

  // Post-deploy verification
  const code = await ethers.provider.getCode(addr)
  const initialized = await poseV2.initialized()
  const domainSeparator = await poseV2.DOMAIN_SEPARATOR()
  console.log("")
  console.log("Verification:")
  console.log(`  code size:        ${(code.length - 2) / 2} bytes`)
  console.log(`  initialized:      ${initialized}`)
  console.log(`  DOMAIN_SEPARATOR: ${domainSeparator}`)
  if (code === "0x" || !initialized || domainSeparator === ethers.ZeroHash) {
    console.error("FAIL: post-deploy verification failed")
    process.exit(1)
  }

  // #686: hand ownership to the multisig if configured.
  const multisig = process.env.MULTISIG_ADDRESS
  if (multisig) {
    console.log("")
    await transferOwnershipChecked(poseV2, "PoSeManagerV2", multisig)
  } else {
    console.log("")
    console.log("WARNING: MULTISIG_ADDRESS not set — PoSeManagerV2 remains owned")
    console.log("         by the deployer (#686 not resolved).")
  }

  console.log("")
  console.log(`NEW_POSEMANAGERV2=${addr}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
