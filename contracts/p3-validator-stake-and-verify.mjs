// p3-validator-stake-and-verify.mjs — Follow-up P3-A:
//
// User's plan §5.3 P3 said: "把 anchor-1/2 stake-register 为 validator,
// 从 quorum=2-of-3 升级到 quorum=3-of-5". The naming maps to the actual
// EVM identities the GCP nodes already use:
//
//   anchor-1 coinbase = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
//                     = anvil index 2 (private key 0x5de4...)
//                     = same identity as upstream validator-3
//   anchor-2 coinbase = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
//                     = anvil index 1 (private key 0x59c6...)
//                     = same identity as upstream validator-2
//
// (Confirmed via eth_coinbase RPC against both nodes 2026-05-09.)
//
// Goal: prove the ValidatorRegistry contract layer + ValidatorRegistryReader
// integration is functional — i.e. anchor-1 and anchor-2 can register, the
// active set returns them, and the runtime reader BFT consumes sees the
// same data. We do NOT claim H15 fallback fires inside the GCP 5-cluster as
// a result — upstream BFT keeps using its hardcoded validator set; that
// path needs a fork-off chain (P3-B) the user has not authorized.
//
// What this WILL do:
//   1. Fund anchor-1's anvil-2 EOA with 1 ETH from deployer (gas only — anchor-1
//      already has plenty as upstream validator-3, but we top up for safety).
//   2. Same for anchor-2 (anvil-1).
//   3. anchor-1 calls stake(nodeId, pubkey) with 32 ETH msg.value.
//   4. anchor-2 calls stake(nodeId, pubkey) with 32 ETH msg.value.
//   5. Read back getActiveValidators() — expect 2 entries.
//   6. Drive ValidatorRegistryReader and confirm it sees both entries.
//
// 64 ETH testnet ETH is locked in the contract afterward (14-day unstake
// lockup applies if the operator wants to recover it).

import { Contract, JsonRpcProvider, Wallet, Transaction, SigningKey, keccak256 } from "ethers"
import { readFile } from "node:fs/promises"

const RPC = "http://104.198.192.85:28780"
const REG = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  // anvil 0
const CHAIN_ID = 18780n
const STAKE_AMOUNT = 32n * 10n ** 18n
const FUEL_AMOUNT = 1n * 10n ** 18n
const GAS_PRICE = 5_000_000_000n
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"

const { abi } = JSON.parse(await readFile(ART, "utf-8"))
const provider = new JsonRpcProvider(RPC)
const reg = new Contract(REG, abi, provider)
const iface = reg.interface
const deployer = new Wallet(DEPLOYER_KEY, provider)

// Anchor identities — anvil indexes 2 and 1, matching the GCP coinbases
// confirmed via eth_coinbase. These are the upstream validator-3 and
// validator-2 keys; using them here registers those existing identities
// in ValidatorRegistry without changing what the upstream BFT consumes.
const ANCHORS = [
  {
    label: "anchor-1",
    pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",  // anvil 2
    expectedAddr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  },
  {
    label: "anchor-2",
    pk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",  // anvil 1
    expectedAddr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
].map((a) => {
  const w = new Wallet(a.pk)
  if (w.address.toLowerCase() !== a.expectedAddr.toLowerCase()) {
    throw new Error(`addr mismatch ${a.label}: ${w.address} != ${a.expectedAddr}`)
  }
  const pubkey = new SigningKey(a.pk).publicKey  // 0x04 || X || Y
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  return { ...a, address: w.address, pubkey, nodeId }
})

console.log("==> P3-A: ValidatorRegistry stake + reader verification")
console.log(`    REG:      ${REG}`)
console.log(`    chainId:  ${CHAIN_ID}`)
console.log(`    deployer: ${deployer.address}`)
console.log()
for (const a of ANCHORS) {
  console.log(`    ${a.label}: ${a.address}  nodeId=${a.nodeId.slice(0,18)}..`)
}

// --- Step 1: pre-flight ----------------------------------------------------
const preActive = await reg.getActiveValidators()
console.log(`\n[pre] active validators on chain: ${preActive.length}`)

// --- Step 2: top up anchors for gas (skip if already funded) --------------
console.log("\n==> Step 2: top up anchors with 1 ETH each for gas")
let depNonce = await provider.getTransactionCount(deployer.address, "latest")
for (const a of ANCHORS) {
  const bal = await provider.getBalance(a.address)
  if (bal >= STAKE_AMOUNT + FUEL_AMOUNT) {
    console.log(`  ${a.label} balance=${(bal/10n**18n).toString()} ETH (sufficient); skip top-up`)
    continue
  }
  const tx = await deployer.populateTransaction({
    to: a.address,
    value: FUEL_AMOUNT,
    nonce: depNonce,
    gasLimit: 21_000n,
    gasPrice: GAS_PRICE,
    type: 0,
    chainId: CHAIN_ID,
  })
  const signed = await deployer.signTransaction(tx)
  const parsed = Transaction.from(signed)
  await provider.broadcastTransaction(signed)
  console.log(`  ${a.label} fuel tx ${parsed.hash}`)
  await provider.waitForTransaction(parsed.hash, 1, 60_000)
  depNonce++
}

// --- Step 3: each anchor calls stake() -------------------------------------
console.log("\n==> Step 3: each anchor calls stake() with 32 ETH")
const stakeTxs = []
for (const a of ANCHORS) {
  const existing = await reg.getValidator(a.nodeId)
  if (existing.operator !== "0x0000000000000000000000000000000000000000") {
    console.log(`  ${a.label} nodeId=${a.nodeId.slice(0,10)}.. already registered (operator=${existing.operator}); skip`)
    continue
  }
  const w = new Wallet(a.pk, provider)
  const stakeNonce = await provider.getTransactionCount(w.address, "latest")
  const data = iface.encodeFunctionData("stake", [a.nodeId, a.pubkey])
  const tx = await w.populateTransaction({
    to: REG,
    data,
    value: STAKE_AMOUNT,
    nonce: stakeNonce,
    gasLimit: 300_000n,
    gasPrice: GAS_PRICE,
    type: 0,
    chainId: CHAIN_ID,
  })
  const signed = await w.signTransaction(tx)
  const parsed = Transaction.from(signed)
  await provider.broadcastTransaction(signed)
  console.log(`  ${a.label} stake tx ${parsed.hash}`)
  stakeTxs.push({ hash: parsed.hash, label: a.label })
}
for (const { hash, label } of stakeTxs) {
  const rcpt = await provider.waitForTransaction(hash, 1, 90_000)
  if (!rcpt || rcpt.status !== 1) {
    console.error(`  ${label} stake tx ${hash} FAILED; status=${rcpt?.status}`)
    process.exit(2)
  }
  console.log(`  ${label} stake confirmed in block ${rcpt.blockNumber}`)
}

// --- Step 4: verify via getActiveValidators() ------------------------------
console.log("\n==> Step 4: read back via getActiveValidators()")
const postActive = await reg.getActiveValidators()
console.log(`  active count: ${postActive.length} (was ${preActive.length})`)
for (const nid of postActive) {
  const v = await reg.getValidator(nid)
  console.log(`  nodeId=${nid.slice(0,18)}.. operator=${v.operator} stake=${(v.stake/10n**18n).toString()}ETH active=${v.active}`)
}

const expected = new Set(ANCHORS.map(a => a.nodeId.toLowerCase()))
const got = new Set(postActive.map(n => n.toLowerCase()))
const missing = [...expected].filter(n => !got.has(n))
if (missing.length > 0) {
  console.error(`  ❌ missing validators: ${missing.join(", ")}`)
  process.exit(3)
}
console.log(`  ✅ both anchor identities are active`)

// --- Step 5: ValidatorRegistryReader integration ---------------------------
console.log("\n==> Step 5: ValidatorRegistryReader integration check")
import { spawnSync } from "node:child_process"
const probe = `
import { ValidatorRegistryReader } from "../runtime/lib/validator-registry-reader.ts"
const reader = new ValidatorRegistryReader({
  rpcUrl: "${RPC}",
  address: "${REG}",
  pollIntervalMs: 60000,
  fromBlock: 30067n,
})
await reader.init()
const set = reader.getActiveSet()
console.log("READER_ACTIVE_COUNT=" + set.length)
for (const e of set) {
  console.log("READER_ENTRY nodeId=" + e.nodeId + " operator=" + e.operator + " stake=" + (e.stake/10n**18n).toString() + "ETH")
}
reader.stop()
`
const res = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", probe], {
  cwd: "/passinger/projects/ClawdBot/COC/contracts",
  encoding: "utf-8",
  timeout: 60_000,
})
process.stdout.write(res.stdout)
if (res.stderr) process.stderr.write(res.stderr)
const readerCount = Number((res.stdout.match(/READER_ACTIVE_COUNT=(\d+)/) || [, "0"])[1])
if (readerCount !== postActive.length) {
  console.error(`  ❌ reader count ${readerCount} != on-chain count ${postActive.length}`)
  process.exit(4)
}
console.log(`  ✅ reader sees all ${readerCount} validators (matches chain state)`)

console.log("\n==> P3-A complete. ValidatorRegistry stake + reader path verified.")
console.log("    Note: GCP 5-cluster BFT keeps running on its hardcoded upstream validator")
console.log("    set; this run only proves the registry contract + reader are functional.")
