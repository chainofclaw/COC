/**
 * Stake a single identity into ValidatorRegistry on chainId 18780.
 *
 * Real ABI (from contracts-src/governance/ValidatorRegistry.sol:178):
 *     function stake(bytes32 nodeId, bytes pubkeyNode) external payable
 *     - pubkeyNode: 65-byte uncompressed (0x04 || X || Y)
 *     - nodeId:     keccak256(pubkeyNode[1:])
 *     - msg.value:  ≥ 32 ETH (MIN_STAKE)
 *
 * Usage:
 *   FUNDER_KEY=0x... STAKER_KEY=0x... STAKE_ETH=32 \
 *     node --experimental-strip-types stake-validator.mjs
 *
 * If FUNDER_KEY != STAKER_KEY, funder transfers (STAKE_ETH + 1) ETH to
 * staker first. Staker then submits stake() from its own address so the
 * validator's `operator` is the staker (required for later
 * requestUnstake/withdraw).
 */
import { JsonRpcProvider, Wallet, Contract, SigningKey, keccak256, getBytes, parseEther, formatEther } from "ethers"
import { HARDHAT_DEV_PRIVATE_KEYS, resolvePrivateKeyForRpc } from "../scripts/lib/key-safety.mjs"

const RPC = process.env.RPC || "http://209.74.64.88:28780"
const REGISTRY = process.env.REGISTRY || "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e"
const FUNDER_KEY = resolvePrivateKeyForRpc({
  envValue: process.env.FUNDER_KEY,
  envName: "FUNDER_KEY",
  fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[0],
  rpcUrl: RPC,
  label: "validator staking",
})
const STAKER_KEY = process.env.STAKER_KEY
if (!STAKER_KEY) { console.error("ERROR: STAKER_KEY env required"); process.exit(2) }
const STAKE_ETH = process.env.STAKE_ETH || "32"

const ABI = [
  "function stake(bytes32 nodeId, bytes pubkeyNode) external payable",
  "function getActiveValidators() external view returns (bytes32[])",
  "function activeValidatorCount() external view returns (uint256)",
  "function getValidator(bytes32 nodeId) external view returns (tuple(bytes32 nodeId, address operator, uint256 stake, uint64 registeredAt, uint64 unstakeRequestedAt, bool active))",
  "function isActive(bytes32 nodeId) external view returns (bool)",
]

const provider = new JsonRpcProvider(RPC)
const funder = new Wallet(FUNDER_KEY, provider)
const staker = new Wallet(STAKER_KEY, provider)

const sk = new SigningKey(STAKER_KEY)
const pubkeyHex = sk.publicKey // 0x04 || X || Y, 132 chars (65 bytes)
const pubBytes = getBytes(pubkeyHex)
if (pubBytes.length !== 65) { console.error(`ERROR: pubkey length ${pubBytes.length} != 65`); process.exit(2) }
const nodeId = keccak256(pubBytes.slice(1))
const trail20 = ("0x" + nodeId.slice(-40)).toLowerCase()
if (trail20 !== staker.address.toLowerCase()) {
  console.error(`ERROR: nodeId trail20 ${trail20} != staker.address ${staker.address.toLowerCase()}`)
  process.exit(2)
}

console.log(`# stake-validator on chainId 18780`)
console.log(`  RPC:        ${RPC}`)
console.log(`  Registry:   ${REGISTRY}`)
console.log(`  Funder:     ${funder.address}`)
console.log(`  Staker:     ${staker.address}`)
console.log(`  nodeId:     ${nodeId}`)
console.log(`  pubkey[0]:  0x${pubkeyHex.slice(2,4)} (must be 04)`)
console.log(`  stake:      ${STAKE_ETH} ETH`)

const reg = new Contract(REGISTRY, ABI, staker)

const existing = await reg.getValidator(nodeId)
if (existing.operator !== "0x0000000000000000000000000000000000000000") {
  console.log(`\n⚠ already registered: operator=${existing.operator} active=${existing.active} stake=${formatEther(existing.stake)} ETH`)
  if (existing.active) { console.log(`✓ already active — nothing to do`); process.exit(0) }
  console.log(`✗ registered but inactive — refusing to re-stake (would revert AlreadyRegistered)`)
  process.exit(1)
}

const stakeWei = parseEther(STAKE_ETH)
const balStaker = await provider.getBalance(staker.address)
console.log(`\n  staker balance pre: ${formatEther(balStaker)} ETH`)

const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n

if (balStaker < stakeWei + parseEther("0.5")) {
  const need = stakeWei + parseEther("1") - balStaker
  console.log(`\n[fund] funder transfers ${formatEther(need)} ETH to staker...`)
  const ftx = await funder.sendTransaction({
    to: staker.address, value: need, gasPrice, type: 0, gasLimit: 21_000,
  })
  const fr = await ftx.wait(1)
  console.log(`  block=${fr.blockNumber} status=${fr.status} ✓`)
}

console.log(`\n[stake] staker calls stake(nodeId, pubkey) value=${STAKE_ETH} ETH...`)
const tx = await reg.stake(nodeId, pubkeyHex, {
  value: stakeWei, gasPrice, type: 0, gasLimit: 500_000,
})
console.log(`  tx hash: ${tx.hash}`)
const r = await tx.wait(1)
if (r.status !== 1) { console.error(`✗ stake reverted`); process.exit(1) }
console.log(`  block=${r.blockNumber} gasUsed=${r.gasUsed} ✓`)

const after = await reg.getValidator(nodeId)
const active = await reg.isActive(nodeId)
const count = await reg.activeValidatorCount()
console.log(`\n# stake confirmed`)
console.log(`  validator.operator:   ${after.operator}`)
console.log(`  validator.stake:      ${formatEther(after.stake)} ETH`)
console.log(`  validator.active:     ${active}`)
console.log(`  active set count now: ${count}`)
