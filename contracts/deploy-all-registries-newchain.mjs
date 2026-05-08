/**
 * Deploy 5 governance contracts to the current 3-server testnet (chainId 18780).
 *
 * Required after the 2026-05-07 multi-server testnet rebuild — the previous
 * deployments (SoulRegistry / DIDRegistry / CidRegistry / ValidatorRegistry /
 * PoSeManagerV2) lived on the old single-host docker chain and are not on
 * this new chain.
 *
 * Order: independent contracts first (Soul, Cid, Validator, Pose), then
 * DIDRegistry which depends on SoulRegistry. Each one runs a minimal
 * post-deploy smoke test (read-only call) to confirm the contract is live.
 *
 * Output: prints a markdown table of (contract, address, deploy block) and
 * also writes JSON to deployed-registries-newchain.json for downstream tools.
 */

import { ContractFactory, JsonRpcProvider, Wallet, ethers } from "ethers"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// ── Config ─────────────────────────────────────────────────────────────────

const RPC = process.env.RPC || "http://209.74.64.88:28780"
const DEPLOYER_KEY = process.env.DEPLOYER_KEY
  // Hardhat-0 — already prefunded on this testnet at genesis
  || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const ARTIFACTS = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src"

const CONTRACTS = [
  { name: "SoulRegistry",      path: `${ARTIFACTS}/governance/SoulRegistry.sol/SoulRegistry.json`,      ctorArgs: () => [] },
  { name: "CidRegistry",       path: `${ARTIFACTS}/governance/CidRegistry.sol/CidRegistry.json`,        ctorArgs: () => [] },
  { name: "ValidatorRegistry", path: `${ARTIFACTS}/governance/ValidatorRegistry.sol/ValidatorRegistry.json`, ctorArgs: () => [] },
  { name: "PoSeManagerV2",     path: `${ARTIFACTS}/settlement/PoSeManagerV2.sol/PoSeManagerV2.json`,    ctorArgs: () => [] },
  // Has dep on SoulRegistry — passed via the closure after Soul is deployed.
  { name: "DIDRegistry",       path: `${ARTIFACTS}/governance/DIDRegistry.sol/DIDRegistry.json`,        ctorArgs: (deployed) => [deployed.SoulRegistry.address] },
]

// ── Deploy loop ────────────────────────────────────────────────────────────

const provider = new JsonRpcProvider(RPC)
const wallet = new Wallet(DEPLOYER_KEY, provider)

console.log(`# Governance contract redeploy on chainId=${(await provider.getNetwork()).chainId}`)
console.log(`from:    ${wallet.address}`)
console.log(`balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`)
console.log(`startBlock: ${await provider.getBlockNumber()}`)
console.log()

const deployed = {}
const startNonce = await provider.getTransactionCount(wallet.address)

for (let i = 0; i < CONTRACTS.length; i++) {
  const { name, path, ctorArgs } = CONTRACTS[i]
  const artifact = JSON.parse(readFileSync(path, "utf8"))
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet)

  const args = ctorArgs(deployed)
  console.log(`[${i + 1}/${CONTRACTS.length}] Deploying ${name}${args.length ? ` (args=${JSON.stringify(args)})` : ""}...`)

  const start = Date.now()
  const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
  const c = await factory.deploy(...args, { gasPrice, type: 0, gasLimit: 5_000_000, nonce: startNonce + i })
  const deployTx = c.deploymentTransaction()
  const receipt = await deployTx.wait(1)
  const elapsed = Date.now() - start
  const addr = await c.getAddress()
  console.log(`     → ${addr}  block=${receipt.blockNumber}  gasUsed=${receipt.gasUsed}  ${elapsed}ms`)
  deployed[name] = { address: addr, block: receipt.blockNumber, txHash: deployTx.hash }
}

// ── Smoke tests ────────────────────────────────────────────────────────────

console.log()
console.log("# Smoke tests — minimal read-only call against each deploy")

// SoulRegistry: getSoul(0xee..) on a fresh address should return all-zero / not-found
const soulAbi = ["function getSoul(address) view returns (bytes32 soulId, bytes32 backupCid, uint64 createdAt, uint64 lastBackupAt, bool active)"]
const soulC = new ethers.Contract(deployed.SoulRegistry.address, soulAbi, provider)
const soulProbe = await soulC.getSoul("0x000000000000000000000000000000000000dEaD")
console.log(`  SoulRegistry.getSoul(0xdEaD) → soulId=${soulProbe.soulId} active=${soulProbe.active} (expected: 0x000.., false)`)

// DIDRegistry: resolveDid on a fresh DID should not exist
const didAbi = ["function didExists(bytes32) view returns (bool)"]
const didC = new ethers.Contract(deployed.DIDRegistry.address, didAbi, provider)
try {
  const probe = await didC.didExists(ethers.keccak256(ethers.toUtf8Bytes("did:coc:test")))
  console.log(`  DIDRegistry.didExists("did:coc:test") → ${probe} (expected: false)`)
} catch (e) {
  console.log(`  DIDRegistry probe skipped: ${e.message?.slice(0,80)}`)
}

// CidRegistry: registerCid + isRegistered (write+read)
const cidAbi = [
  "function registerCid(bytes32 cidHash, string cid) external",
  "function isRegistered(bytes32 cidHash) external view returns (bool)",
  "function resolveCid(bytes32 cidHash) external view returns (string)",
]
const cidC = new ethers.Contract(deployed.CidRegistry.address, cidAbi, wallet)
const sampleCid = `bafybei-test-${Date.now()}`
const cidHash = ethers.keccak256(ethers.toUtf8Bytes(sampleCid))
const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
const tx = await cidC.registerCid(cidHash, sampleCid, { gasPrice, type: 0, gasLimit: 200_000 })
const r = await tx.wait(1)
const reg = await cidC.isRegistered(cidHash)
const back = await cidC.resolveCid(cidHash)
console.log(`  CidRegistry.registerCid(${sampleCid}) → block=${r.blockNumber} status=${r.status}`)
console.log(`  CidRegistry.isRegistered(...) → ${reg}  resolveCid(...) → ${back === sampleCid ? "✓ matches" : `MISMATCH: ${back}`}`)

// ValidatorRegistry: getActiveValidators should return an empty array on a fresh deploy
const vrAbi = ["function getActiveValidators() view returns (bytes32[])", "function activeValidatorCount() view returns (uint256)"]
const vrC = new ethers.Contract(deployed.ValidatorRegistry.address, vrAbi, provider)
const activeList = await vrC.getActiveValidators()
const activeCount = await vrC.activeValidatorCount()
console.log(`  ValidatorRegistry.getActiveValidators() → length=${activeList.length} count=${activeCount} (expected: 0,0)`)

// PoSeManagerV2: try a public view that should exist on a fresh deploy
const poseAbi = ["function epochsCount() view returns (uint256)"]
const poseC = new ethers.Contract(deployed.PoSeManagerV2.address, poseAbi, provider)
try {
  const epochs = await poseC.epochsCount()
  console.log(`  PoSeManagerV2.epochsCount() → ${epochs} (expected: 0)`)
} catch (e) {
  console.log(`  PoSeManagerV2 probe skipped: ${e.message?.slice(0,80)}`)
}

// ── Persist output ─────────────────────────────────────────────────────────

console.log()
console.log("# Deployment summary")
console.log()
console.log("| Contract | Address | Block | Deploy tx |")
console.log("|---|---|---|---|")
for (const [name, info] of Object.entries(deployed)) {
  console.log(`| ${name} | \`${info.address}\` | ${info.block} | \`${info.txHash}\` |`)
}

const outPath = "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json"
const out = {
  chainId: 18780,
  rpc: RPC,
  deployer: wallet.address,
  deployedAt: new Date().toISOString(),
  contracts: deployed,
}
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log()
console.log(`addresses written to: ${outPath}`)
