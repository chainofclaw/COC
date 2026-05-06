import { Contract, JsonRpcProvider, Wallet, keccak256, getAddress } from "ethers"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
const __dirname = dirname(fileURLToPath(import.meta.url))

const RPC = "http://199.192.16.79:28782"
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = join(__dirname, "artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json")

// Stake the 2 remaining anvil keys (idx 1 + 2; idx 0 already staked).
const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // node-2
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // node-3
]

const { abi } = JSON.parse(await readFile(ART, "utf-8"))
const provider = new JsonRpcProvider(RPC)

for (const pk of KEYS) {
  const w = new Wallet(pk, provider)
  const pubkey = w.signingKey.publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  console.log(`\nstaking ${getAddress(w.address)} nodeId=${nodeId}`)
  const reg = new Contract(REG, abi, w)
  const active = await reg.isActive(nodeId)
  if (active) { console.log("  already active, skipping"); continue }
  const nonce = await provider.getTransactionCount(w.address, "pending")
  const tx = await reg.stake(nodeId, pubkey, {
    value: 32n * 10n ** 18n, nonce, gasLimit: 250_000n, gasPrice: 2_000_000_000n,
  })
  console.log(`  tx: ${tx.hash}`)
  const r = await tx.wait(1)
  console.log(`  ${r.status === 1 ? "✓ staked" : "✗ failed"} block=${r.blockNumber}`)
}

const reader = new Contract(REG, abi, provider)
const all = await reader.getActiveValidators()
console.log(`\n✓ active set: ${all.length} validators`)
for (const id of all) console.log(`  - ${id} → ${("0x" + id.slice(-40)).toLowerCase()}`)
