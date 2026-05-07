// Fund ext-3 + ext-4 (the unregistered BFT proposers causing stalls), then stake.
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
  ["0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", "ext-3"],
  ["0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", "ext-4"],
]

const provider = new JsonRpcProvider(RPCS[0])

async function broadcastSigned(signed) {
  let any = false
  for (const url of RPCS) {
    try { await new JsonRpcProvider(url).broadcastTransaction(signed); any = true } catch {}
  }
  return any
}

async function pollReceipt(hash, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const url of RPCS) {
      try {
        const r = await new JsonRpcProvider(url).getTransactionReceipt(hash)
        if (r) return r
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return null
}

const deployerWallet = new Wallet(DEPLOYER, provider)
let depNonce = await provider.getTransactionCount(deployerWallet.address, "latest")
console.log(`deployer ${deployerWallet.address} starting nonce=${depNonce}`)

for (const [pk, label] of TARGETS) {
  const recipient = new Wallet(pk).address
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
  else console.log(`  ✗ no receipt 300s`)
  depNonce++
}

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
  else console.log(`  ✗ no receipt 300s`)
}

const all = await reg.getActiveValidators()
console.log(`\nfinal active set: ${all.length} validators`)
for (const id of all) console.log(`  - ${id}`)
