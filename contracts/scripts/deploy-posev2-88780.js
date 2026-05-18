/**
 * Standalone redeploy of PoSeManagerV2 to 88780 (post-#676 pull-payment fix).
 * PoSeManagerV2 has no constructor args and zero on-chain dependents, so a
 * standalone redeploy does not cascade stale cross-references.
 */
const { ethers } = require("hardhat")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
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

  // Post-deploy verification
  const code = await ethers.provider.getCode(addr)
  const owner = await poseV2.owner()
  const initialized = await poseV2.initialized()
  console.log("")
  console.log("Verification:")
  console.log(`  code size:   ${(code.length - 2) / 2} bytes`)
  console.log(`  owner:       ${owner}  (deployer match: ${owner.toLowerCase() === deployer.address.toLowerCase()})`)
  console.log(`  initialized: ${initialized}  (expected false — initialize() is owner-gated, deploy-pending)`)

  if (code === "0x" || owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.error("FAIL: post-deploy verification failed")
    process.exit(1)
  }
  console.log("")
  console.log(`NEW_POSEMANAGERV2=${addr}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
