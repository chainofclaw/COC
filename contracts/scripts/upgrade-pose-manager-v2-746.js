/**
 * Upgrade preparation for PoSeManagerV2 #746 fix.
 *
 * USAGE
 *   COC_RPC_URL=https://<88780-rpc> \
 *   npx hardhat run scripts/upgrade-pose-manager-v2-746.js --network coc
 *
 * What this script does
 * ---------------------
 * 1. Runs `upgrades.validateUpgrade` against the live PoSeManagerV2 proxy to
 *    assert the new implementation's storage layout is compatible (i.e. the
 *    `__gap` reduction + `_witnessSigUsed` addition introduced in PR #766
 *    are append-only and do NOT relocate any existing slot).
 * 2. Runs `upgrades.prepareUpgrade` which:
 *    - Deploys the new implementation bytecode to 88780.
 *    - Writes the impl entry into `.openzeppelin/unknown-88780.json` so the
 *      OZ plugin tracks it for future upgrades.
 *    - Returns the new implementation address — DO NOT call `upgradeProxy`
 *      from here; the proxy is owned by a Gnosis Safe multisig, and the
 *      actual `upgradeToAndCall` tx must come from the multisig (see
 *      scripts/safe-propose-pose-upgrade-746.ts).
 *
 * Outputs
 * -------
 * - `tmp/upgrade-746-prepared.json` — { proxy, newImpl, contractName,
 *   chainId, preparedAt } — consumed by safe-propose-pose-upgrade-746.ts.
 *
 * Safety
 * ------
 * - No live proxy state is touched. The new impl ends up at a fresh address
 *   and is wired to the proxy only when the multisig executes the proposal.
 * - The script aborts if `validateUpgrade` reports any layout violation;
 *   inspect the OZ output and fix the storage definition before retrying.
 */

const fs = require("node:fs")
const path = require("node:path")
const { ethers, upgrades } = require("hardhat")

const DEPLOYED_88780 = path.join(__dirname, "..", "..", "configs", "deployed-contracts-88780.json")

async function main() {
  const deployed = JSON.parse(fs.readFileSync(DEPLOYED_88780, "utf8"))
  if (deployed.chainId !== 88780) {
    throw new Error(`expected deployed-contracts manifest for chainId=88780, got ${deployed.chainId}`)
  }
  const proxy = deployed.contracts.PoSeManagerV2
  if (!/^0x[0-9a-fA-F]{40}$/.test(proxy)) {
    throw new Error(`PoSeManagerV2 address missing or malformed in ${DEPLOYED_88780}: ${proxy}`)
  }

  const provider = ethers.provider
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== 88780) {
    throw new Error(
      `network mismatch: connected to chainId=${network.chainId}, expected 88780. ` +
      `Set COC_RPC_URL / COC_CHAIN_ID for the 88780 testnet before running.`
    )
  }

  console.log(`PoSeManagerV2 #746 upgrade — preparing new implementation`)
  console.log(`  proxy:       ${proxy}`)
  console.log(`  network:     ${network.name} (chainId ${network.chainId})`)

  const Factory = await ethers.getContractFactory("PoSeManagerV2")

  console.log(`  validating storage layout compatibility...`)
  await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" })
  console.log(`    ✓ layout compatible`)

  console.log(`  deploying new implementation (no proxy state changes)...`)
  const newImplAddress = await upgrades.prepareUpgrade(proxy, Factory, { kind: "uups" })
  if (typeof newImplAddress !== "string") {
    throw new Error(`prepareUpgrade returned non-string: ${String(newImplAddress)}`)
  }
  console.log(`    ✓ new impl deployed: ${newImplAddress}`)

  const out = {
    proxy,
    newImpl: newImplAddress,
    contractName: "PoSeManagerV2",
    chainId: 88780,
    preparedAt: new Date().toISOString(),
    refs: ["#746", "PR #766", "PR #713"],
  }
  const outDir = path.join(__dirname, "..", "tmp")
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, "upgrade-746-prepared.json")
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n")
  console.log(`  wrote ${outPath}`)

  console.log("")
  console.log(`Next step: propose the upgradeToAndCall tx to the Safe owning ${proxy}:`)
  console.log(`  npx ts-node scripts/safe-propose-pose-upgrade-746.ts`)
  console.log(`(Reads ${outPath}; multisig signers approve via the Safe UI.)`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
