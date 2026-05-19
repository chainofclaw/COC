/**
 * Deploy-time safety helpers (#686).
 *
 * The 88780 contracts were originally deployed with the default Hardhat test
 * account #0 as deployer — and therefore as owner. That account's private key
 * is published in every Hardhat install, so every onlyOwner function was
 * effectively permissionless. These helpers stop that from recurring and make
 * the post-deploy ownership handoff to a multisig verifiable.
 */

// Known Hardhat / anvil default test accounts (mnemonic:
// "test test test test test test test test test test test junk").
// Their private keys are public — they must never own production contracts.
const HARDHAT_TEST_ACCOUNTS = new Set(
  [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
    "0xBcd4042DE499D14e55001CcbB24a551F3b954096",
    "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
    "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
    "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
    "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097",
    "0xcd3B766CCDd6AE721141F452C550Ca635964ce71",
    "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
    "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
    "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
    "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
  ].map((a) => a.toLowerCase()),
)

/**
 * Abort the deploy if `address` is a public Hardhat test account, unless
 * ALLOW_HARDHAT_DEPLOYER=1 is explicitly set (for local hardhat-network runs).
 */
function assertSafeDeployer(address) {
  if (!HARDHAT_TEST_ACCOUNTS.has(String(address).toLowerCase())) return
  if (process.env.ALLOW_HARDHAT_DEPLOYER === "1") {
    console.warn(
      `WARNING: deploying with Hardhat test account ${address} ` +
        "(ALLOW_HARDHAT_DEPLOYER=1). Never do this on a live network.",
    )
    return
  }
  console.error(
    `FATAL: deployer ${address} is a public Hardhat test account — its ` +
      "private key is public (#686). Set DEPLOYER_PRIVATE_KEY to a securely " +
      "held key, or set ALLOW_HARDHAT_DEPLOYER=1 for a throwaway local run.",
  )
  process.exit(1)
}

/**
 * Call transferOwnership on a contract and assert the new owner stuck.
 * Aborts the deploy if the on-chain owner does not match — a wrong target on
 * a non-upgradeable contract would lock admin functions forever.
 */
async function transferOwnershipChecked(contract, name, multisigAddress) {
  const tx = await contract.transferOwnership(multisigAddress)
  await tx.wait()
  const newOwner = await contract.owner()
  if (String(newOwner).toLowerCase() !== String(multisigAddress).toLowerCase()) {
    console.error(
      `FATAL: ${name}.owner is ${newOwner}, expected ${multisigAddress}`,
    )
    process.exit(1)
  }
  console.log(`  ${name}: ownership -> ${multisigAddress}`)
}

module.exports = {
  HARDHAT_TEST_ACCOUNTS,
  assertSafeDeployer,
  transferOwnershipChecked,
}
