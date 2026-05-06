// Phase X2: stake node-2 and node-3 via port 28780 (node-1 RPC) to avoid
// any mempool stuck-tx residue from earlier 28782 attempts.
import { Contract, JsonRpcProvider, Wallet, keccak256 } from "ethers"
import { readFile } from "node:fs/promises"
const RPC = "http://199.192.16.79:28780"
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))
const provider = new JsonRpcProvider(RPC)

const KEYS = [
  ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "node-2"],
  ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "node-3"],
]

for (const [pk, label] of KEYS) {
  const w = new Wallet(pk, provider)
  const pubkey = w.signingKey.publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  const reg = new Contract(REG, abi, w)
  if (await reg.isActive(nodeId)) { console.log(`${label}: already active`); continue }
  const nonce = await provider.getTransactionCount(w.address, "pending")
  console.log(`${label}: nonce=${nonce}`)
  try {
    const tx = await reg.stake(nodeId, pubkey, {
      value: 32n * 10n ** 18n, nonce, gasLimit: 250_000n, gasPrice: 16_000_000_000n,
    })
    console.log(`  tx=${tx.hash}`)
    const r = await Promise.race([tx.wait(1), new Promise((_, rej) => setTimeout(() => rej(new Error("60s timeout")), 60_000))]).catch(e => ({ error: String(e) }))
    console.log(r.error || `  block=${r.blockNumber} status=${r.status}`)
  } catch (e) {
    console.log(`  send error: ${String(e).slice(0, 200)}`)
  }
}
const reader = new Contract(REG, abi, provider)
const all = await reader.getActiveValidators()
console.log(`\nactive set: ${all.length} validators`)
for (const id of all) console.log(`  - ${("0x" + id.slice(-40)).toLowerCase()}`)
