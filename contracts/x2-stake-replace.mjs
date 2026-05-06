// Phase X2: replace stuck nonce-3 pending tx on node-2 + submit fresh node-3
// stake. Uses gasPrice 4× the original 2 gwei to evict mempool entries.
import { Contract, JsonRpcProvider, Wallet, keccak256 } from "ethers"
import { readFile } from "node:fs/promises"
const RPC = "http://199.192.16.79:28782"
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))
const provider = new JsonRpcProvider(RPC)

// Use `latest` (mined) nonce as base — replaces any stuck pending txs.
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
  const active = await reg.isActive(nodeId)
  if (active) { console.log(`${label}: already active`); continue }
  const latestNonce = await provider.getTransactionCount(w.address, "latest")
  console.log(`${label}: stake nonce=${latestNonce}`)
  const tx = await reg.stake(nodeId, pubkey, {
    value: 32n * 10n ** 18n,
    nonce: latestNonce,
    gasLimit: 250_000n,
    gasPrice: 8_000_000_000n,  // 8 gwei (4× the stuck 2 gwei)
  })
  console.log(`  tx: ${tx.hash}`)
  // Use 90s timeout instead of indefinite wait
  const r = await Promise.race([
    tx.wait(1),
    new Promise((_, rej) => setTimeout(() => rej(new Error("90s timeout")), 90_000)),
  ]).catch((e) => ({ error: String(e) }))
  if (r.error) console.log(`  ${r.error}`)
  else console.log(`  ${r.status === 1 ? "✓ staked" : "✗ failed"} block=${r.blockNumber}`)
}

const reader = new Contract(REG, abi, provider)
const all = await reader.getActiveValidators()
console.log(`\nactive set: ${all.length} validators`)
for (const id of all) console.log(`  - ${("0x" + id.slice(-40)).toLowerCase()}`)
