/**
 * Post-deploy initialize for PoSeManagerV2.
 *
 * Unlike the other 4 registries, PoSeManagerV2 sets its EIP-712
 * DOMAIN_SEPARATOR via an `initialize(chainId, verifyingContract,
 * challengeBondMin)` call rather than the constructor. Smoke test
 * flagged DOMAIN_SEPARATOR=0x000…; this script populates it.
 */
import { JsonRpcProvider, Wallet, ethers } from "ethers"
import { readFileSync } from "node:fs"

const RPC = process.env.RPC || "http://209.74.64.88:28780"
const KEY = process.env.DEPLOYER_KEY
  || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const deployed = JSON.parse(readFileSync(
  "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json",
  "utf8",
))
const poseAddr = deployed.contracts.PoSeManagerV2.address
const provider = new JsonRpcProvider(RPC)
const wallet = new Wallet(KEY, provider)
const chainId = 18780

const abi = [
  "function initialize(uint256 chainId, address verifyingContract, uint256 _challengeBondMin) external",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function challengeBondMin() view returns (uint256)",
  "function MIN_BOND() view returns (uint256)",
]
const c = new ethers.Contract(poseAddr, abi, wallet)

const minBond = await c.MIN_BOND()
const domBefore = await c.DOMAIN_SEPARATOR()
console.log(`PoSeManagerV2 ${poseAddr}`)
console.log(`  MIN_BOND constant: ${ethers.formatEther(minBond)} ETH`)
console.log(`  DOMAIN_SEPARATOR before: ${domBefore}`)

if (domBefore !== "0x" + "00".repeat(32)) {
  console.log("already initialized — exiting")
  process.exit(0)
}

const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
console.log(`\ncalling initialize(${chainId}, ${poseAddr}, ${minBond})...`)
const tx = await c.initialize(chainId, poseAddr, minBond, { gasPrice, type: 0, gasLimit: 300_000 })
console.log(`  tx: ${tx.hash}`)
const r = await tx.wait(1)
console.log(`  block: ${r.blockNumber}  status: ${r.status}  gasUsed: ${r.gasUsed}`)

const domAfter = await c.DOMAIN_SEPARATOR()
const bondAfter = await c.challengeBondMin()
console.log(`\nDOMAIN_SEPARATOR after: ${domAfter}`)
console.log(`challengeBondMin after: ${ethers.formatEther(bondAfter)} ETH`)
if (domAfter === "0x" + "00".repeat(32)) {
  console.log("✗ DOMAIN_SEPARATOR still zero — initialize did not take effect")
  process.exit(1)
}
console.log("\n✓ PoSeManagerV2 initialized")
