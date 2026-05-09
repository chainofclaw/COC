/**
 * R2.1 Phase A — deploy the PoSe v2 contract suite on the H15 fork-off
 * devnet (chainId 88888) so coc-agent + coc-relayer sidecars can drive a
 * full epoch lifecycle against an isolated chain.
 *
 * Reuses contracts/deploy-all-registries-newchain.mjs and init-pose-newchain.mjs
 * patterns but targets the fork-off RPC at http://localhost:38790 instead of
 * the upstream 209.74.64.88. anvil-0 is prefunded on the H15 fixture (see
 * configs-h15/node-1.json prefund block).
 *
 * Output: tests/multinode-integration/configs-h15/deployed-pose.json
 *
 * Usage (after H15 fixture is up via run-h15.sh up):
 *   node --experimental-strip-types tests/multinode-integration/scripts/deploy-pose-on-h15.mjs
 *
 * Idempotent: if PoSeManagerV2 is already initialized (DOMAIN_SEPARATOR != 0)
 * the script reports the existing addresses and exits 0.
 */

import { ContractFactory, JsonRpcProvider, Wallet, ethers } from "ethers"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

const RPC = process.env.RPC || "http://localhost:38790"          // h15-node-1 RPC
const DEPLOYER_KEY =
  process.env.DEPLOYER_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CHAIN_ID = 88888
const OUT_PATH = "/passinger/projects/ClawdBot/COC/tests/multinode-integration/configs-h15/deployed-pose.json"
const ARTIFACTS = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src"

// Same set as R1.1 governance suite + PoSeManagerV2 + CidRegistry. The
// CidRegistry must be present because runtime/coc-agent.ts initializes a
// CidRegistryReader against it during startup; without a valid registry
// address the reader's refresh() can hang silently (no error in logs)
// and the agent's setInterval(tick) never registers — the symptom is
// that the agent emits "endpoint fingerprint mode" + "reward targets
// refreshed" logs once and then goes quiet (observed 2026-05-09).
const CONTRACTS = [
  { name: "CidRegistry",       path: `${ARTIFACTS}/governance/CidRegistry.sol/CidRegistry.json`,             ctorArgs: () => [] },
  { name: "ValidatorRegistry", path: `${ARTIFACTS}/governance/ValidatorRegistry.sol/ValidatorRegistry.json`, ctorArgs: () => [] },
  { name: "PoSeManagerV2",     path: `${ARTIFACTS}/settlement/PoSeManagerV2.sol/PoSeManagerV2.json`,         ctorArgs: () => [] },
  { name: "InsuranceFund",     path: `${ARTIFACTS}/governance/InsuranceFund.sol/InsuranceFund.json`,         ctorArgs: (_, w) => [w.address] },
  { name: "EquivocationDetector", path: `${ARTIFACTS}/governance/EquivocationDetector.sol/EquivocationDetector.json`, ctorArgs: (d) => [d.ValidatorRegistry.address] },
]

// Anvil index 0..4 — the same keys h15-node-1..5 use, and prefunded on the
// fork-off chain via configs-h15/node-1.json `prefund` block.
const VALIDATOR_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
]

const provider = new JsonRpcProvider(RPC)
const wallet = new Wallet(DEPLOYER_KEY, provider)

// Whole-script deadline: belt-and-suspenders for the case where neither
// tx.wait nor a read-only RPC call hits its individual timeout but the
// script just stalls (observed 2026-05-09 retry runs where deploy was
// at block 48/16-tx still running after 8 min). 7 min hard cap.
const SCRIPT_DEADLINE_MS = Number(process.env.DEPLOY_SCRIPT_DEADLINE_MS ?? 7 * 60_000)
setTimeout(() => {
  console.error(`==> deploy-pose-on-h15.mjs exceeded ${SCRIPT_DEADLINE_MS / 1000}s deadline; aborting`)
  process.exit(124)
}, SCRIPT_DEADLINE_MS).unref()

// Bounded wait wrapper: ethers' default tx.wait() can hang forever if the
// node's filter polling loses the receipt (observed 2026-05-09 retry runs
// where deploy stuck after enableEmission). 60s budget per tx is generous
// for a single-block confirmation on this fork-off chain.
async function waitTx(tx, label) {
  const start = Date.now()
  return await Promise.race([
    tx.wait(1),
    new Promise((_, rej) => setTimeout(() =>
      rej(new Error(`tx.wait timeout after 60s: ${label} (hash=${tx.hash})`)), 60_000)),
  ]).then((rcpt) => {
    if (Date.now() - start > 30_000) console.warn(`    ⚠ slow confirm: ${label} took ${(Date.now() - start) / 1000}s`)
    return rcpt
  })
}

console.log(`==> R2.1 Phase A: deploy PoSe suite on H15 fork (chainId ${CHAIN_ID})`)
const net = await provider.getNetwork()
if (Number(net.chainId) !== CHAIN_ID) {
  console.error(`ERROR: connected chainId=${net.chainId}, expected ${CHAIN_ID}. Wrong RPC?`)
  process.exit(1)
}
console.log(`    deployer: ${wallet.address}`)
console.log(`    balance:  ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`)
console.log()

// Idempotency: if deployed-pose.json already exists AND PoSeManagerV2 is
// initialized, exit early.
let existing = {}
if (existsSync(OUT_PATH)) {
  existing = JSON.parse(readFileSync(OUT_PATH, "utf8"))
  if (existing.contracts?.PoSeManagerV2?.initialized) {
    console.log(`    already deployed; reusing ${OUT_PATH}`)
    console.log(`    PoSeManagerV2: ${existing.contracts.PoSeManagerV2.address}`)
    process.exit(0)
  }
}

// ── Step 1: deploy 4 contracts ─────────────────────────────────────────────
const deployed = {}
let nonce = await provider.getTransactionCount(wallet.address)
const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n

for (const c of CONTRACTS) {
  const art = JSON.parse(readFileSync(c.path, "utf8"))
  const factory = new ContractFactory(art.abi, art.bytecode, wallet)
  const args = c.ctorArgs(deployed, wallet)
  console.log(`  deploy ${c.name}${args.length ? ` (args=${JSON.stringify(args)})` : ""}`)
  const inst = await factory.deploy(...args, { gasPrice, type: 0, gasLimit: 5_000_000, nonce: nonce++ })
  const tx = inst.deploymentTransaction()
  const rcpt = await waitTx(tx, `deploy ${c.name}`)
  const addr = await inst.getAddress()
  console.log(`    → ${addr} (block ${rcpt.blockNumber})`)
  deployed[c.name] = { address: addr, block: rcpt.blockNumber, abi: art.abi }
}

// ── Step 2: PoSeManagerV2.initialize(chainId, verifyingContract, MIN_BOND) ─
const poseAbi = [
  "function initialize(uint256 chainId, address verifyingContract, uint256 _challengeBondMin) external",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function MIN_BOND() view returns (uint256)",
]
const pose = new ethers.Contract(deployed.PoSeManagerV2.address, poseAbi, wallet)
const minBond = await pose.MIN_BOND()
console.log(`\n==> Initialize PoSeManagerV2 (challengeBondMin=${ethers.formatEther(minBond)} ETH)`)
const initTx = await pose.initialize(CHAIN_ID, deployed.PoSeManagerV2.address, minBond, {
  gasPrice, type: 0, gasLimit: 300_000, nonce: nonce++,
})
await initTx.wait(1)
const ds = await pose.DOMAIN_SEPARATOR()
if (ds === "0x" + "00".repeat(32)) {
  console.error("  ❌ DOMAIN_SEPARATOR still zero")
  process.exit(2)
}
console.log(`  ✅ DOMAIN_SEPARATOR set: ${ds.slice(0, 18)}…`)
deployed.PoSeManagerV2.initialized = true
deployed.PoSeManagerV2.domainSeparator = ds

// ── Step 3: stake 5 validators (each uses its own anvil key) ───────────────
const vrAbi = [
  "function stake(bytes32 nodeId, bytes calldata pubkeyNode) external payable",
  "function getActiveValidators() view returns (bytes32[])",
  "function getValidator(bytes32) view returns (tuple(bytes32 nodeId, address operator, uint256 stake, uint64 registeredAt, uint64 unstakeRequestedAt, bool active))",
]
const vr = new ethers.Contract(deployed.ValidatorRegistry.address, vrAbi, provider)
const STAKE_AMOUNT = ethers.parseEther("32")

console.log(`\n==> Stake 5 validators in ValidatorRegistry (32 ETH each)`)
const stakedNodeIds = []
for (let i = 0; i < VALIDATOR_KEYS.length; i++) {
  const w = new Wallet(VALIDATOR_KEYS[i], provider)
  const signing = new ethers.SigningKey(VALIDATOR_KEYS[i])
  const pubkey = signing.publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = ethers.keccak256(xy)
  stakedNodeIds.push(nodeId)

  // Skip if already registered
  const existing = await vr.getValidator(nodeId)
  if (existing.operator !== ethers.ZeroAddress) {
    console.log(`  validator-${i + 1} ${w.address.slice(0, 10)}… already staked`)
    continue
  }

  // Each validator needs gas — they were prefunded only on chain via genesis
  // (anvil-0 has 10000 ETH per configs-h15/node-1.json). Move some to each.
  // For simplicity we use anvil-0 to fund each; in production validators
  // self-fund.
  const isDeployerSelf = w.address.toLowerCase() === wallet.address.toLowerCase()

  const balance = await provider.getBalance(w.address)
  if (balance < STAKE_AMOUNT + ethers.parseEther("1")) {
    console.log(`  funding validator-${i + 1} (${w.address.slice(0, 10)}…)`)
    const fundTx = await wallet.sendTransaction({
      to: w.address, value: STAKE_AMOUNT + ethers.parseEther("1"),
      gasPrice, type: 0, gasLimit: 21_000, nonce: nonce++,
    })
    await waitTx(fundTx, `fund validator-${i + 1}`)
  }

  // CRITICAL: when validator wallet === deployer wallet (anvil-0 case),
  // we must use the global `nonce` counter, NOT a fresh getTransactionCount,
  // otherwise this stake tx and the next loop's fund tx (also from
  // deployer) end up with the same nonce → TRANSACTION_REPLACED.
  const stakeNonce = isDeployerSelf
    ? nonce++
    : await provider.getTransactionCount(w.address)

  const c = new ethers.Contract(deployed.ValidatorRegistry.address, vrAbi, w)
  const tx = await c.stake(nodeId, pubkey, {
    value: STAKE_AMOUNT, gasPrice, type: 0, gasLimit: 300_000, nonce: stakeNonce,
  })
  const rcpt = await waitTx(tx, `stake validator-${i + 1}`)
  console.log(`  validator-${i + 1} ${w.address.slice(0, 10)}… staked tx=${tx.hash.slice(0, 18)}… block=${rcpt.blockNumber}`)
}

const active = await vr.getActiveValidators()
console.log(`\n==> ValidatorRegistry active count: ${active.length}/5`)

// ── Step 4: wire ValidatorRegistry → EquivocationDetector + InsuranceFund ──
const vrOwnerAbi = [
  "function setSlasher(address) external",
  "function setInsuranceFund(address) external",
]
const vrW = new ethers.Contract(deployed.ValidatorRegistry.address, vrOwnerAbi, wallet)
console.log(`\n==> Wire ValidatorRegistry → EquivocationDetector + InsuranceFund`)
let wTx = await vrW.setSlasher(deployed.EquivocationDetector.address, { gasPrice, type: 0, gasLimit: 100_000, nonce: nonce++ })
await waitTx(wTx, "setSlasher")
console.log(`  setSlasher → ${deployed.EquivocationDetector.address}`)
wTx = await vrW.setInsuranceFund(deployed.InsuranceFund.address, { gasPrice, type: 0, gasLimit: 100_000, nonce: nonce++ })
await waitTx(wTx, "setInsuranceFund")
console.log(`  setInsuranceFund → ${deployed.InsuranceFund.address}`)

// ── Step 5: PoSeManagerV2.registerNode for each of 5 validators ────────────
// Per contracts/test/pose-v2-e2e.test.cjs:133 + PoSeManagerV2.sol:761
//   ownershipSig = personal_sign( keccak256("coc-register:" || nodeId || operator_addr) )
// where operator = node owner = msg.sender of registerNode().
// Each validator wallet stakes itself (operator == nodeAddr), bond = MIN_BOND
// (read from contract; defaults 0.02 ETH per recent deploys).
const poseRegAbi = [
  "function registerNode(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, bytes32 metadataHash, bytes ownershipSig, bytes endpointAttestation) external payable",
  "function MIN_BOND() view returns (uint256)",
  "function operatorNodeCount(address) view returns (uint8)",
  "function getActiveNodeCount() view returns (uint256)",
  "event NodeRegistered(bytes32 indexed nodeId, address indexed operator, uint8 serviceFlags, uint256 bondAmount)",
]
const poseReg = new ethers.Contract(deployed.PoSeManagerV2.address, poseRegAbi, provider)
const minBondReg = await poseReg.MIN_BOND()
console.log(`\n==> Register 5 nodes in PoSeManagerV2 (bond=${ethers.formatEther(minBondReg)} ETH each)`)

// CRITICAL: PoSeManagerV2 uses a DIFFERENT nodeId convention than
// ValidatorRegistry. Per PoSeManagerV2.sol L127: keccak256(pubkeyNode)
// where pubkeyNode is the FULL 65-byte pubkey including 0x04 prefix.
// ValidatorRegistry strips the prefix (keccak256(pubkeyNode[1:])) — see
// ValidatorRegistry.sol L181. So a node has two distinct ids in these
// two registries; we must use the contract-specific one for each.
for (let i = 0; i < VALIDATOR_KEYS.length; i++) {
  const w = new Wallet(VALIDATOR_KEYS[i], provider)
  const signing = new ethers.SigningKey(VALIDATOR_KEYS[i])
  const pubkey = signing.publicKey
  // PoSeManagerV2-style: keccak256(full pubkey including 0x04 prefix).
  const poseNodeId = ethers.keccak256(pubkey)

  // Skip if already registered
  const existingCount = await poseReg.operatorNodeCount(w.address)
  if (Number(existingCount) > 0) {
    console.log(`  validator-${i + 1} ${w.address.slice(0, 10)}… already registered (count=${existingCount})`)
    continue
  }

  // serviceFlags = 7 (challenger + aggregator + storage all enabled)
  const serviceFlags = 7
  const serviceCommitment = ethers.keccak256(ethers.toUtf8Bytes(`coc-svc-h15-v${i + 1}`))
  const endpointCommitment = ethers.keccak256(ethers.toUtf8Bytes(`coc-ep-h15-v${i + 1}`))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("h15-fork-meta"))

  // ownershipSig: personal_sign of packed("coc-register:", poseNodeId, operatorAddr)
  const messageHash = ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", poseNodeId, w.address])
  )
  const ownershipSig = await w.signMessage(ethers.getBytes(messageHash))

  const isDeployerSelf = w.address.toLowerCase() === wallet.address.toLowerCase()
  const regNonce = isDeployerSelf
    ? nonce++
    : await provider.getTransactionCount(w.address)

  const c = new ethers.Contract(deployed.PoSeManagerV2.address, poseRegAbi, w)
  const tx = await c.registerNode(
    poseNodeId, pubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x",
    { value: minBondReg, gasPrice, type: 0, gasLimit: 600_000, nonce: regNonce }
  )
  const rcpt = await waitTx(tx, `registerNode validator-${i + 1}`)
  console.log(`  validator-${i + 1} ${w.address.slice(0, 10)}… registerNode tx=${tx.hash.slice(0, 18)}… block=${rcpt.blockNumber}`)
}

const activeNodeCount = await poseReg.getActiveNodeCount()
console.log(`==> PoSeManagerV2 active node count: ${activeNodeCount}/5`)

// ── Step 6: enableEmission (PoSeManagerV2 needs token + genesisEpoch to fire) ──
// emission is owner-only; token can be a dummy (we use deployer EOA address as
// placeholder since chainId 88888 has no real COC token deployed). genesisEpoch
// = current block timestamp / 60 minutes (1-hour epochs per agent log evidence).
const poseEmitAbi = [
  "function enableEmission(address token, uint64 _genesisEpoch) external",
  "function emissionEnabled() view returns (bool)",
]
const poseE = new ethers.Contract(deployed.PoSeManagerV2.address, poseEmitAbi, wallet)
const alreadyEnabled = await poseE.emissionEnabled()
if (!alreadyEnabled) {
  // genesisEpoch = current epoch (matches agent's epochId computation)
  const currentEpoch = Math.floor(Date.now() / 3_600_000)
  console.log(`\n==> enableEmission(token=deployer, genesisEpoch=${currentEpoch})`)
  // Use deployer address as a dummy COC token address — fork chain has no
  // ERC20 deployed; agent doesn't actually transfer COC, just reads epoch state.
  const emTx = await poseE.enableEmission(wallet.address, currentEpoch, {
    gasPrice, type: 0, gasLimit: 100_000, nonce: nonce++,
  })
  await waitTx(emTx, "enableEmission")
  console.log(`  emissionEnabled = ${await poseE.emissionEnabled()}`)
}

// ── Persist ────────────────────────────────────────────────────────────────
const out = {
  chainId: CHAIN_ID,
  rpc: RPC,
  deployedAt: new Date().toISOString(),
  deployer: wallet.address,
  contracts: Object.fromEntries(
    Object.entries(deployed).map(([k, v]) => [k, { address: v.address, block: v.block, ...(v.initialized ? { initialized: true, domainSeparator: v.domainSeparator } : {}) }])
  ),
  validators: stakedNodeIds.map((nid, i) => ({ nodeId: nid, key_index: i })),
}
writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8")
console.log(`\n==> Wrote ${OUT_PATH}`)
console.log(`==> Phase A deployment complete`)
