/**
 * In-place upgrade of the PoSeManagerV2 UUPS proxy on 88780.
 *
 * Since gen-5 (UUPS conversion), PoSeManagerV2 lives behind a proxy. To ship
 * a code change, this script compiles the new implementation, validates it
 * against the storage layout the OpenZeppelin upgrades plugin recorded in
 * `contracts/.openzeppelin/coc-88780.json`, and calls `upgradeToAndCall` on
 * the existing proxy.
 *
 * The upgrade tx must be sent by the proxy's `owner` — which after the gen-5
 * handoff is the 3-of-5 multisig. That means in production this script is
 * really used to *prepare* the new implementation and the encoded
 * `upgradeToAndCall` calldata for multisig signing; the deployer key alone
 * cannot push the upgrade through. For testnet ad-hoc upgrades, the multisig
 * signs via its normal flow.
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY  — must be non-public (preflight enforces). For the
 *                           actual on-chain upgrade tx the proxy's `owner`
 *                           (the multisig) must sign; this script will revert
 *                           if the deployer is not the owner. Use multisig
 *                           tooling to construct the tx if needed.
 *   POSEV2_PROXY_ADDR     — required; the existing PoSeManagerV2 proxy.
 *   COC_RPC_URL / COC_CHAIN_ID
 */
const { ethers, upgrades } = require("hardhat")
const { assertSafeDeployer } = require("./preflight.js")

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  assertSafeDeployer(deployer.address)

  const proxyAddr = process.env.POSEV2_PROXY_ADDR
  if (!proxyAddr) {
    throw new Error("POSEV2_PROXY_ADDR is required (the existing PoSeManagerV2 proxy)")
  }

  console.log(`Network:  chainId ${network.chainId}`)
  console.log(`Caller:   ${deployer.address}`)
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`)
  console.log(`Proxy:    ${proxyAddr}`)
  console.log("")

  console.log("Compiling and validating new PoSeManagerV2 implementation against stored layout...")
  const NewFactory = await ethers.getContractFactory("PoSeManagerV2")

  // upgradeProxy will:
  //   1. validate storage layout against contracts/.openzeppelin/coc-88780.json
  //   2. deploy the new implementation if its bytecode hash differs
  //   3. call proxy.upgradeToAndCall(newImpl, "") — this requires the caller
  //      to be the proxy's `owner` (multisig in gen-5). If the deployer is
  //      not the owner the tx reverts with OnlyOwner.
  const upgraded = await upgrades.upgradeProxy(proxyAddr, NewFactory, { kind: "uups" })
  await upgraded.waitForDeployment()

  const code = await ethers.provider.getCode(proxyAddr)
  const initialized = await upgraded.initialized()
  const challengeBondMin = await upgraded.challengeBondMin()
  console.log("")
  console.log("Upgrade verification:")
  console.log(`  proxy code size:  ${(code.length - 2) / 2} bytes`)
  console.log(`  initialized:      ${initialized}  (should remain true post-upgrade)`)
  console.log(`  challengeBondMin: ${challengeBondMin}`)

  if (code === "0x" || !initialized) {
    console.error("FAIL: post-upgrade verification failed")
    process.exit(1)
  }

  console.log("")
  console.log("PoSeManagerV2 upgraded in-place; proxy address unchanged.")
  console.log(`POSEV2_PROXY=${proxyAddr}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
