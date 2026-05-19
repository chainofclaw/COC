/**
 * Deploy the MultiSigWallet that owns the COC 88780 contracts (#686).
 *
 * Run this FIRST, capture the printed MULTISIG_ADDRESS, then export it so
 * deploy-governance.js / deploy-all-88780.js hand ownership to this wallet.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   MULTISIG_OWNERS=0xaaa,0xbbb,0xccc,0xddd,0xeee \
 *   MULTISIG_THRESHOLD=3 \
 *     npx hardhat run scripts/deploy-multisig-88780.js --network coc
 *
 * MULTISIG_THRESHOLD defaults to a simple majority (floor(N/2)+1).
 */
const { ethers } = require("hardhat")
const { assertSafeDeployer } = require("./preflight.js")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  // #686: refuse to deploy from a public Hardhat test account.
  assertSafeDeployer(deployer.address)

  const ownersRaw = process.env.MULTISIG_OWNERS
  if (!ownersRaw) {
    throw new Error("MULTISIG_OWNERS is required (comma-separated addresses)")
  }
  const owners = ownersRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (owners.length === 0) throw new Error("MULTISIG_OWNERS is empty")
  for (const o of owners) {
    if (!ethers.isAddress(o)) throw new Error(`invalid owner address: ${o}`)
  }
  const threshold = process.env.MULTISIG_THRESHOLD
    ? parseInt(process.env.MULTISIG_THRESHOLD, 10)
    : Math.floor(owners.length / 2) + 1
  if (!(threshold > 0 && threshold <= owners.length)) {
    throw new Error(
      `invalid MULTISIG_THRESHOLD ${threshold} for ${owners.length} owners`,
    )
  }

  console.log("=== COC MultiSigWallet Deployment (#686) ===")
  console.log(`Network:   chainId ${network.chainId}`)
  console.log(`Deployer:  ${deployer.address}`)
  console.log(`Owners (${owners.length}):`)
  for (const o of owners) console.log(`  ${o}`)
  console.log(`Threshold: ${threshold}-of-${owners.length}`)
  console.log("")

  const MultiSigWallet = await ethers.getContractFactory("MultiSigWallet")
  const wallet = await MultiSigWallet.deploy(owners, threshold)
  await wallet.waitForDeployment()
  const addr = await wallet.getAddress()

  // Post-deploy verification
  const onChainOwners = await wallet.getOwners()
  const onChainRequired = Number(await wallet.required())
  const ownersMatch =
    onChainOwners.length === owners.length &&
    owners.every((o, i) => onChainOwners[i].toLowerCase() === o.toLowerCase())
  if (!ownersMatch || onChainRequired !== threshold) {
    console.error("FAIL: post-deploy verification mismatch")
    process.exit(1)
  }

  console.log(`MultiSigWallet deployed: ${addr}`)
  console.log("")
  console.log(`MULTISIG_ADDRESS=${addr}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
