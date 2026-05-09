/**
 * claw-mem-style end-to-end integration test against the redeployed
 * registries on the 3-server testnet (chainId 18780).
 *
 * Exercises the full backup/recovery workflow that claw-mem (or
 * coc-backup descendants) would drive in production:
 *
 *   1. Generate a synthetic AI-agent identity (agentId, identityCid).
 *   2. EIP-712-sign RegisterSoul, call SoulRegistry.registerSoul.
 *   3. Verify via souls[agentId] read-back.
 *   4. Generate a backup manifest CID, register it in CidRegistry
 *      (the permissionless lookup table claw-mem would use to surface
 *      "the on-chain pointer" → "the human-readable IPFS CID string").
 *   5. EIP-712-sign AnchorBackup with the manifest CID, call
 *      SoulRegistry.anchorBackup. Verify backupCount / lastBackupAt
 *      moved.
 *   6. Optional cross-link: insert a DIDRegistry verification method
 *      tying the agent's keypair to the soul.
 *
 * Each step asserts on read-back; failure exits non-zero.
 */
import { JsonRpcProvider, Wallet, ethers } from "ethers"
import { readFileSync } from "node:fs"

const RPC = process.env.RPC || "http://209.74.64.88:28780"
// Generate an ephemeral agent each run so registerSoul always hits the
// "fresh address" path. Hardhat-0 funds it with 1 ETH for gas.
const FUNDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const ephemeral = ethers.Wallet.createRandom()
const KEY = process.env.AGENT_KEY || ephemeral.privateKey

const deployed = JSON.parse(readFileSync(
  "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json",
  "utf8",
))

const provider = new JsonRpcProvider(RPC)
const wallet = new Wallet(KEY, provider)
const funder = new Wallet(FUNDER_KEY, provider)
const chainId = 18780n

const soulAddr = deployed.contracts.SoulRegistry.address
const cidAddr  = deployed.contracts.CidRegistry.address
const didAddr  = deployed.contracts.DIDRegistry.address

console.log(`# claw-mem e2e (chainId=${chainId}, agent=${wallet.address})`)
console.log(`  SoulRegistry: ${soulAddr}`)
console.log(`  CidRegistry:  ${cidAddr}`)
console.log(`  DIDRegistry:  ${didAddr}`)

const gasPriceFactory = async () =>
  ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
const baseTx = async () => ({ gasPrice: await gasPriceFactory(), type: 0, gasLimit: 600_000 })

// ── 0. Fund the ephemeral agent from hardhat-0 ────────────────────────────
const initBal = await provider.getBalance(wallet.address)
console.log(`  agent initial balance: ${ethers.formatEther(initBal)} ETH`)
if (initBal < ethers.parseEther("0.05")) {
  const fundAmount = ethers.parseEther("0.5")
  console.log(`\n[0] funding agent ${wallet.address} with ${ethers.formatEther(fundAmount)} ETH from ${funder.address} ...`)
  const fundTx = await funder.sendTransaction({
    to: wallet.address,
    value: fundAmount,
    gasPrice: await gasPriceFactory(),
    type: 0,
    gasLimit: 21_000,
  })
  const fr = await fundTx.wait(1)
  if (fr.status !== 1) { console.log(`✗ funding tx failed`); process.exit(1) }
  const newBal = await provider.getBalance(wallet.address)
  console.log(`    block=${fr.blockNumber} ✓ funded — agent balance: ${ethers.formatEther(newBal)} ETH`)
}
console.log()

// ── 1. Generate synthetic identity ────────────────────────────────────────
const agentId = ethers.keccak256(ethers.toUtf8Bytes(`claw-mem-agent-${Date.now()}-${wallet.address}`))
const identityCidString = `bafybei-claw-mem-identity-${Date.now()}`
const identityCid = ethers.keccak256(ethers.toUtf8Bytes(identityCidString))
console.log(`[1] generated agentId = ${agentId.slice(0,18)}…`)
console.log(`    identityCid (keccak): ${identityCid.slice(0,18)}…`)
console.log(`    identityCid (string): ${identityCidString}`)

// ── 2. registerSoul (EIP-712 signed) ──────────────────────────────────────
const soulAbi = [
  "function registerSoul(bytes32 agentId, bytes32 identityCid, bytes ownershipSig) external",
  "function anchorBackup(bytes32 agentId, bytes32 manifestCid, bytes32 dataMerkleRoot, uint32 fileCount, uint64 totalBytes, uint8 backupType, bytes32 parentManifestCid, bytes ownershipSig) external",
  "function souls(bytes32) view returns (bytes32 agentId, address owner, bytes32 identityCid, bytes32 latestSnapshotCid, uint64 registeredAt, uint64 lastBackupAt, uint32 backupCount, uint16 version, bool active)",
  "function nonces(bytes32) view returns (uint64)",
]
const soul = new ethers.Contract(soulAddr, soulAbi, wallet)

const domain = {
  name: "COCSoulRegistry",
  version: "1",
  chainId,
  verifyingContract: soulAddr,
}
const registerTypes = {
  RegisterSoul: [
    { name: "agentId",     type: "bytes32" },
    { name: "identityCid", type: "bytes32" },
    { name: "owner",       type: "address" },
    { name: "nonce",       type: "uint64"  },
  ],
}

const nonce0 = await soul.nonces(agentId)
const registerValue = { agentId, identityCid, owner: wallet.address, nonce: nonce0 }
const registerSig = await wallet.signTypedData(domain, registerTypes, registerValue)
console.log(`\n[2] registerSoul tx: signing nonce=${nonce0} ...`)
const tx2 = await soul.registerSoul(agentId, identityCid, registerSig, await baseTx())
const r2 = await tx2.wait(1)
if (r2.status !== 1) { console.log(`✗ registerSoul reverted: ${r2}`); process.exit(1) }
console.log(`    block=${r2.blockNumber} gasUsed=${r2.gasUsed} ✓`)

// ── 3. souls[agentId] read-back ───────────────────────────────────────────
const sRow = await soul.souls(agentId)
console.log(`\n[3] souls[agentId] read-back:`)
console.log(`    owner=${sRow.owner}  identityCid=${sRow.identityCid.slice(0,18)}…  active=${sRow.active}`)
if (sRow.owner.toLowerCase() !== wallet.address.toLowerCase()) {
  console.log(`✗ owner mismatch: got=${sRow.owner} want=${wallet.address}`)
  process.exit(1)
}
if (sRow.identityCid !== identityCid) {
  console.log(`✗ identityCid mismatch: got=${sRow.identityCid} want=${identityCid}`)
  process.exit(1)
}
if (!sRow.active) { console.log(`✗ soul not active`); process.exit(1) }
console.log(`    ✓ owner + identityCid + active match`)

// ── 4. Register backup CID in CidRegistry ─────────────────────────────────
const backupCidString = `bafybei-claw-mem-backup-manifest-${Date.now()}`
const backupCidHash = ethers.keccak256(ethers.toUtf8Bytes(backupCidString))
const cidAbi = [
  "function registerCid(bytes32 cidHash, string cid) external",
  "function resolveCid(bytes32 cidHash) external view returns (string)",
]
const cid = new ethers.Contract(cidAddr, cidAbi, wallet)
console.log(`\n[4] CidRegistry.registerCid for backup manifest...`)
const tx4 = await cid.registerCid(backupCidHash, backupCidString, await baseTx())
const r4 = await tx4.wait(1)
if (r4.status !== 1) { console.log(`✗ registerCid reverted`); process.exit(1) }
const back = await cid.resolveCid(backupCidHash)
if (back !== backupCidString) {
  console.log(`✗ resolveCid mismatch: got=${back} want=${backupCidString}`)
  process.exit(1)
}
console.log(`    block=${r4.blockNumber} ✓ resolveCid roundtrip`)

// ── 5. anchorBackup (EIP-712 signed) ──────────────────────────────────────
const anchorTypes = {
  AnchorBackup: [
    { name: "agentId",            type: "bytes32" },
    { name: "manifestCid",        type: "bytes32" },
    { name: "dataMerkleRoot",     type: "bytes32" },
    { name: "fileCount",          type: "uint32"  },
    { name: "totalBytes",         type: "uint64"  },
    { name: "backupType",         type: "uint8"   },
    { name: "parentManifestCid",  type: "bytes32" },
    { name: "nonce",              type: "uint64"  },
  ],
}
const dataMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes("synthetic-merkle-root"))
const fileCount = 12
const totalBytes = 524288n // 512 KB
// Contract enforces: backupType=1 (incremental) requires parentManifestCid != 0.
// First backup has no parent, so use backupType=0 (full).
const backupType = 0
const parentManifestCid = "0x" + "00".repeat(32)

const nonce1 = await soul.nonces(agentId)
const anchorValue = {
  agentId,
  manifestCid: backupCidHash,
  dataMerkleRoot,
  fileCount,
  totalBytes,
  backupType,
  parentManifestCid,
  nonce: nonce1,
}
const anchorSig = await wallet.signTypedData(domain, anchorTypes, anchorValue)
console.log(`\n[5] anchorBackup tx: signing nonce=${nonce1} ...`)
const tx5 = await soul.anchorBackup(
  agentId, backupCidHash, dataMerkleRoot, fileCount, totalBytes, backupType, parentManifestCid, anchorSig,
  await baseTx(),
)
const r5 = await tx5.wait(1)
if (r5.status !== 1) { console.log(`✗ anchorBackup reverted`); process.exit(1) }
console.log(`    block=${r5.blockNumber} gasUsed=${r5.gasUsed} ✓`)

// ── 6. souls[agentId] after backup ────────────────────────────────────────
const sRow2 = await soul.souls(agentId)
console.log(`\n[6] souls[agentId] post-backup:`)
console.log(`    backupCount=${sRow2.backupCount}  lastBackupAt=${sRow2.lastBackupAt}  latestSnapshotCid=${sRow2.latestSnapshotCid.slice(0,18)}…`)
if (sRow2.backupCount !== 1n) {
  console.log(`✗ backupCount expected 1, got ${sRow2.backupCount}`)
  process.exit(1)
}
if (sRow2.latestSnapshotCid !== backupCidHash) {
  console.log(`✗ latestSnapshotCid mismatch: got=${sRow2.latestSnapshotCid} want=${backupCidHash}`)
  process.exit(1)
}
if (sRow2.lastBackupAt === 0n) { console.log(`✗ lastBackupAt not set`); process.exit(1) }
console.log(`    ✓ all post-backup fields updated`)

// ── 7. summary ────────────────────────────────────────────────────────────
console.log(`\n# E2E integration: PASS`)
console.log(`  agentId         ${agentId}`)
console.log(`  identityCid     ${identityCidString} (hash ${identityCid.slice(0,18)}…)`)
console.log(`  backupCid       ${backupCidString} (hash ${backupCidHash.slice(0,18)}…)`)
console.log(`  registeredAt    ${new Date(Number(sRow.registeredAt) * 1000).toISOString()}`)
console.log(`  lastBackupAt    ${new Date(Number(sRow2.lastBackupAt) * 1000).toISOString()}`)
console.log(`  blocks consumed ${r2.blockNumber}, ${r4.blockNumber}, ${r5.blockNumber}`)
