// Live-add 5th validator (ext-2 / anvil idx 6) without any cluster
// restart. Watch the reader on cores log a count update via its poll
// interval (default 60s).
import { Contract, JsonRpcProvider, Wallet, keccak256, Transaction, SigningKey } from "ethers"
import { readFile } from "node:fs/promises"

const RPCS = [
  "http://199.192.16.79:28780",
  "http://199.192.16.79:28782",
  "http://199.192.16.79:28784",
  "http://199.192.16.79:38790",
  "http://199.192.16.79:38792",
  "http://199.192.16.79:38794",
  "http://199.192.16.79:38796",
]
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))

const TARGET_PK = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" // anvil idx 6 = ext-2
const FUNDING_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const provider = new JsonRpcProvider(RPCS[0])
const target = new Wallet(TARGET_PK, provider)
const targetPubkey = new SigningKey(TARGET_PK).publicKey
const targetNodeId = keccak256("0x" + targetPubkey.slice(4))
console.log(`target ext-2: ${target.address}`)
console.log(`target nodeId: ${targetNodeId}`)

const reg = new Contract(REG, abi, provider)
const before = (await reg.getActiveValidators()).length
console.log(`\nbefore stake: ${before} validators on chain`)

if (await reg.isActive(targetNodeId)) {
  console.log("already active — exiting"); process.exit(0)
}

// Fund if needed
const targetBal = await provider.getBalance(target.address)
if (targetBal < 35n * 10n ** 18n) {
  const funder = new Wallet(FUNDING_PK, provider)
  const fNonce = await provider.getTransactionCount(funder.address, "latest")
  const tx = await funder.populateTransaction({
    to: target.address, value: 50n * 10n ** 18n, nonce: fNonce,
    gasLimit: 21_000n, gasPrice: 5_000_000_000n, type: 0, chainId: 18780n,
  })
  const signed = await funder.signTransaction(tx)
  for (const url of RPCS) { try { await new JsonRpcProvider(url).broadcastTransaction(signed) } catch {} }
  const fHash = Transaction.from(signed).hash
  console.log(`fund tx: ${fHash}`)
  // wait
  const dl = Date.now() + 90_000
  while (Date.now() < dl) {
    const r = await provider.getTransactionReceipt(fHash).catch(() => null)
    if (r) { console.log(`  ✓ funded block=${r.blockNumber}`); break }
    await new Promise((r) => setTimeout(r, 4000))
  }
}

// Stake from target
const sNonce = await provider.getTransactionCount(target.address, "latest")
const data = reg.interface.encodeFunctionData("stake", [targetNodeId, targetPubkey])
const stx = await target.populateTransaction({
  to: REG, data, value: 32n * 10n ** 18n, nonce: sNonce,
  gasLimit: 300_000n, gasPrice: 5_000_000_000n, type: 0, chainId: 18780n,
})
const signed = await target.signTransaction(stx)
for (const url of RPCS) { try { await new JsonRpcProvider(url).broadcastTransaction(signed) } catch {} }
const sHash = Transaction.from(signed).hash
console.log(`\nstake tx: ${sHash}`)

const dl = Date.now() + 180_000
let receipt
while (Date.now() < dl) {
  receipt = await provider.getTransactionReceipt(sHash).catch(() => null)
  if (receipt) break
  await new Promise((r) => setTimeout(r, 4000))
}
if (!receipt) { console.log(`✗ no receipt within 180s`); process.exit(1) }
console.log(`  ✓ staked block=${receipt.blockNumber} status=${receipt.status}`)

const after = (await reg.getActiveValidators()).length
console.log(`\nafter stake: ${after} validators on chain`)
console.log(`stake landed at block ${receipt.blockNumber}`)
console.log(`\nNow watch cores' validator-registry-reader logs for next 90s`)
console.log(`to verify auto-pickup WITHOUT restart...`)
