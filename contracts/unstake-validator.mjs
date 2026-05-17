/**
 * Call ValidatorRegistry.requestUnstake(nodeId) to remove an entry from
 * the active BFT set. The 32 ETH stake remains locked in the contract
 * for UNSTAKE_LOCKUP=14 days; after that the operator can call
 * withdrawStake(). Active-set removal is immediate.
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
  label: "validator unstaking",
})
const OPERATOR_KEY = process.env.OPERATOR_KEY
if (!OPERATOR_KEY) { console.error("ERROR: OPERATOR_KEY env required"); process.exit(2) }
const TARGET_NODE_ID = process.env.TARGET_NODE_ID
if (!TARGET_NODE_ID) { console.error("ERROR: TARGET_NODE_ID env required"); process.exit(2) }

const ABI = [
  "function requestUnstake(bytes32 nodeId) external",
  "function getValidator(bytes32 nodeId) external view returns (tuple(bytes32 nodeId, address operator, uint256 stake, uint64 registeredAt, uint64 unstakeRequestedAt, bool active))",
  "function isActive(bytes32 nodeId) external view returns (bool)",
  "function activeValidatorCount() external view returns (uint256)",
]

const provider = new JsonRpcProvider(RPC)
const funder = new Wallet(FUNDER_KEY, provider)
const op = new Wallet(OPERATOR_KEY, provider)
const reg = new Contract(REGISTRY, ABI, op)

const v = await reg.getValidator(TARGET_NODE_ID)
console.log(`# requestUnstake on chainId 18780`)
console.log(`  Registry:           ${REGISTRY}`)
console.log(`  Operator:           ${op.address}`)
console.log(`  Target nodeId:      ${TARGET_NODE_ID}`)
console.log(`  Validator.operator: ${v.operator}`)
console.log(`  Validator.stake:    ${formatEther(v.stake)} ETH`)
console.log(`  Validator.active:   ${v.active}`)
if (v.operator === "0x0000000000000000000000000000000000000000") {
  console.error(`✗ not registered`); process.exit(1)
}
if (v.operator.toLowerCase() !== op.address.toLowerCase()) {
  console.error(`✗ operator mismatch — only operator ${v.operator} can call requestUnstake`); process.exit(1)
}
if (!v.active) {
  console.log(`⚠ already inactive — nothing to do`); process.exit(0)
}

const balOp = await provider.getBalance(op.address)
const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
console.log(`  operator balance pre: ${formatEther(balOp)} ETH`)
if (balOp < parseEther("0.01")) {
  console.log(`\n[fund] funder transfers 0.5 ETH to operator for gas...`)
  const ftx = await funder.sendTransaction({ to: op.address, value: parseEther("0.5"), gasPrice, type: 0, gasLimit: 21_000 })
  await ftx.wait(1)
}

console.log(`\n[unstake] operator calls requestUnstake(${TARGET_NODE_ID.slice(0,18)}…)`)
const tx = await reg.requestUnstake(TARGET_NODE_ID, { gasPrice, type: 0, gasLimit: 200_000 })
console.log(`  tx hash: ${tx.hash}`)
const r = await tx.wait(1)
if (r.status !== 1) { console.error(`✗ requestUnstake reverted`); process.exit(1) }
console.log(`  block=${r.blockNumber} gasUsed=${r.gasUsed} ✓`)

const after = await reg.getValidator(TARGET_NODE_ID)
const count = await reg.activeValidatorCount()
console.log(`\n# unstake confirmed`)
console.log(`  validator.active:   ${after.active}`)
console.log(`  unstakeRequestedAt: ${new Date(Number(after.unstakeRequestedAt)*1000).toISOString()}`)
console.log(`  active set count:   ${count}`)
