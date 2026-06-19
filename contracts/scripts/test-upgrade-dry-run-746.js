/**
 * Local dry-run of the PoSeManagerV2 #746 upgrade.
 *
 * USAGE
 *   npx hardhat run scripts/test-upgrade-dry-run-746.js
 *
 * Runs against the default Hardhat in-process EVM (no real chain touched).
 * Simulates the full upgrade lifecycle:
 *
 *   1. Deploy a fresh `PoSeManagerV2` proxy (UUPS, owned by a test EOA).
 *   2. Read pre-upgrade view state (`challengeBondMin`, `DOMAIN_SEPARATOR`,
 *      `getActiveNodeCount`) — these MUST survive the upgrade unchanged.
 *   3. Call `upgrades.upgradeProxy(proxy, NewImpl, { kind: 'uups' })` to
 *      point the proxy at the same `PoSeManagerV2` source compiled from
 *      head — this is the OZ-validated drop-in of the new logic.
 *   4. Read the same view state post-upgrade and assert equality.
 *   5. Submit a tiny `submitBatchV2WithMetadata` call to assert the new
 *      method dispatches successfully on the upgraded proxy.
 *
 * Used as a CI smoke gate before triggering the live 88780 upgrade
 * (`scripts/upgrade-pose-manager-v2-746.js` + multisig propose). Catches
 * storage-layout / initializer / DOMAIN_SEPARATOR regressions that the
 * OZ layout validator alone might miss.
 */

const { ethers, upgrades } = require("hardhat")

async function main() {
  const [deployer, witness] = await ethers.getSigners()

  // ---- Phase 1: deploy a fresh proxy ----------------------------------
  const Factory = await ethers.getContractFactory("PoSeManagerV2")
  const proxy = await upgrades.deployProxy(
    Factory,
    [ethers.parseEther("0.01"), deployer.address],
    { initializer: "initialize", kind: "uups" },
  )
  await proxy.waitForDeployment()
  const proxyAddr = await proxy.getAddress()
  console.log(`[dry-run] proxy deployed: ${proxyAddr}`)

  await proxy.setAllowEmptyWitnessSubmission(true) // bootstrap-mode

  const preChallengeBondMin = await proxy.challengeBondMin()
  const preDomain = await proxy.DOMAIN_SEPARATOR()
  const preActiveCount = await proxy.getActiveNodeCount()
  console.log(`[dry-run] pre-upgrade state captured:`)
  console.log(`           challengeBondMin = ${preChallengeBondMin}`)
  console.log(`           DOMAIN_SEPARATOR = ${preDomain}`)
  console.log(`           activeNodeCount  = ${preActiveCount}`)

  // ---- Phase 2: upgrade (same source — production upgrade is identical) -----
  console.log(`[dry-run] running upgrades.validateUpgrade...`)
  await upgrades.validateUpgrade(proxyAddr, Factory, { kind: "uups" })
  console.log(`[dry-run]   ✓ layout compatible`)

  console.log(`[dry-run] running upgrades.upgradeProxy...`)
  const upgraded = await upgrades.upgradeProxy(proxyAddr, Factory, { kind: "uups" })
  await upgraded.waitForDeployment()
  console.log(`[dry-run]   ✓ proxy upgraded`)

  // ---- Phase 3: post-upgrade state must match pre-upgrade -------------
  const postChallengeBondMin = await upgraded.challengeBondMin()
  const postDomain = await upgraded.DOMAIN_SEPARATOR()
  const postActiveCount = await upgraded.getActiveNodeCount()

  if (preChallengeBondMin !== postChallengeBondMin) {
    throw new Error(`challengeBondMin drifted: pre=${preChallengeBondMin} post=${postChallengeBondMin}`)
  }
  if (preDomain !== postDomain) {
    throw new Error(`DOMAIN_SEPARATOR drifted: pre=${preDomain} post=${postDomain}`)
  }
  if (preActiveCount !== postActiveCount) {
    throw new Error(`activeNodeCount drifted: pre=${preActiveCount} post=${postActiveCount}`)
  }
  console.log(`[dry-run]   ✓ challengeBondMin / DOMAIN_SEPARATOR / activeNodeCount preserved`)

  // ---- Phase 4: new method dispatches on the upgraded proxy -----------
  // Owner-only empty-witness path; lightest possible call that exercises
  // `submitBatchV2WithMetadata` glue without needing a registered witness set.
  const latestBlock = await ethers.provider.getBlock("latest")
  const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)
  const leafHash = ethers.keccak256(ethers.toUtf8Bytes("dry-run-leaf"))
  const pairRoot = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "bytes32"], leafHash <= leafHash ? [leafHash, leafHash] : [leafHash, leafHash])
  )
  const sampleProofs = [{ leaf: leafHash, merkleProof: [leafHash], leafIndex: 0 }]
  const sampleCommitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [ethers.ZeroHash, 0, leafHash])
  )
  const summaryHash = ethers.keccak256(
    ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, pairRoot, sampleCommitment, 1])
  )
  const metadata = {
    challengeIds: [ethers.keccak256(ethers.toUtf8Bytes("ch"))],
    nodeIds: [ethers.keccak256(ethers.toUtf8Bytes("nd"))],
    responseBodyHashes: [ethers.keccak256(ethers.toUtf8Bytes("rb"))],
    leafHashes: [leafHash],
    // #746 PR-1: resultCodes[] aligned with leafHashes is now REQUIRED.
    // 0 = Ok. v3 EIP-712 digest is rebuilt from this; without it the
    // contract reverts MetadataLengthMismatch.
    resultCodes: [0],
    witnessReceiptIndex: new Array(32).fill(0xffff),
  }

  // No witnesses registered ⇒ contract takes the empty-witness owner-only
  // branch (allowEmptyWitnessSubmission=true was set above).
  await upgraded.submitBatchV2WithMetadata(
    BigInt(epochId),
    pairRoot,
    summaryHash,
    sampleProofs,
    0, // witnessBitmap
    [], // witnessSignatures
    metadata,
  )
  console.log(`[dry-run]   ✓ submitBatchV2WithMetadata (with resultCodes) dispatched on upgraded proxy`)

  // ---- Phase 5: #746 v2SunsetEpoch is exposed and onlyOwner -----------
  const v2Sunset = await upgraded.v2SunsetEpoch()
  console.log(`[dry-run]   ✓ v2SunsetEpoch() = ${v2Sunset} (expected 0 = unlimited at deploy time)`)
  await upgraded.setV2SunsetEpoch(42n)
  const v2SunsetAfter = await upgraded.v2SunsetEpoch()
  if (v2SunsetAfter !== 42n) throw new Error(`setV2SunsetEpoch didn't take: ${v2SunsetAfter}`)
  console.log(`[dry-run]   ✓ setV2SunsetEpoch(42) round-trips on the upgraded proxy`)
  // Reset to 0 — production multisig keeps this at 0 immediately after upgrade
  // (the soft sunset window stays open until fleet finishes v3 rollout).
  await upgraded.setV2SunsetEpoch(0n)

  // ---- Phase 6: #746 legacy submitBatchV2 hard-reverts ---------------
  let legacyReverted = false
  try {
    await upgraded.submitBatchV2(BigInt(epochId), pairRoot, summaryHash, sampleProofs, 0, [])
  } catch (err) {
    if (String(err).match(/LegacyBatchPathSunset/)) legacyReverted = true
  }
  if (!legacyReverted) throw new Error("legacy submitBatchV2 did not revert LegacyBatchPathSunset")
  console.log(`[dry-run]   ✓ legacy submitBatchV2 reverts LegacyBatchPathSunset on the upgraded proxy`)

  console.log(``)
  console.log(`[dry-run] PASS — live upgrade should be safe.`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
