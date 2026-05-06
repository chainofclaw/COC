// Fund node-2 + node-3 with 50 ETH each from deployer, then stake them.
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

const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TARGETS = [
  ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "node-2", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "node-3", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
]

const provider = new JsonRpcProvider(RPCS[0])

async function broadcastSigned(signed) {
  let any = false
  for (const url of RPCS) {
    try { await new JsonRpcProvider(url).broadcastTransaction(signed); any = true } catch {}
  }
  return any
}

async function pollReceipt(hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await provider.getTransactionReceipt(hash)
      if (r) return r
    } catch {}
    await new Promise((r) => setTimeout(r, 4000))
  }
  return null
}

// Step 1: fund node-2 and node-3 from deployer
const deployerWallet = new Wallet(DEPLOYER, provider)
let depNonce = await provider.getTransactionCount(deployerWallet.address, "latest")
console.log(`deployer ${deployerWallet.address} starting nonce=${depNonce}`)

for (const [, label, recipient] of TARGETS) {
  const tx = await deployerWallet.populateTransaction({
    to: recipient,
    value: 50n * 10n ** 18n,
    nonce: depNonce,
    gasLimit: 21_000n,
    gasPrice: 5_000_000_000n,
    type: 0,
    chainId: 18780n,
  })
  const signed = await deployerWallet.signTransaction(tx)
  const hash = Transaction.from(signed).hash
  console.log(`fund ${label}: tx=${hash}`)
  await broadcastSigned(signed)
  const r = await pollReceipt(hash)
  if (r) console.log(`  ✓ block=${r.blockNumber} status=${r.status}`)
  else console.log(`  ✗ no receipt 120s`)
  depNonce++
}

// Step 2: stake each target with their own key
console.log("\n--- staking ---")
const reg = new Contract(REG, abi, provider)
const iface = reg.interface

for (const [pk, label] of TARGETS) {
  const w = new Wallet(pk, provider)
  const pubkey = new SigningKey(pk).publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  if (await reg.isActive(nodeId)) { console.log(`${label}: already active`); continue }

  const nonce = await provider.getTransactionCount(w.address, "latest")
  const balance = await provider.getBalance(w.address)
  console.log(`${label} ${w.address} nonce=${nonce} bal=${(Number(balance)/1e18).toFixed(4)}`)

  const data = iface.encodeFunctionData("stake", [nodeId, pubkey])
  const tx = await w.populateTransaction({
    to: REG,
    data,
    value: 32n * 10n ** 18n,
    nonce,
    gasLimit: 300_000n,
    gasPrice: 5_000_000_000n,
    type: 0,
    chainId: 18780n,
  })
  const signed = await w.signTransaction(tx)
  const hash = Transaction.from(signed).hash
  console.log(`  stake tx: ${hash}`)
  await broadcastSigned(signed)
  const r = await pollReceipt(hash)
  if (r) console.log(`  ✓ block=${r.blockNumber} status=${r.status}`)
  else console.log(`  ✗ no receipt 120s`)
}

const all = await reg.getActiveValidators()
console.log(`\nfinal active set: ${all.length} validators`)
for (const id of all) console.log(`  - ${id}`)
