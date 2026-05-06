// Stake 3 cores into ValidatorRegistry. Each anvil key signs its own
// stake tx with 32 ETH and broadcasts to all 7 validator RPCs so the
// tx lives in every mempool (avoids the recovery-time fork pattern).
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

const KEYS = [
  ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "node-1"],
  ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "node-2"],
  ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "node-3"],
]

const provider = new JsonRpcProvider(RPCS[0])
const reg = new Contract(REG, abi, provider)
const iface = reg.interface

for (const [pk, label] of KEYS) {
  const w = new Wallet(pk, provider)
  const pubkey = new SigningKey(pk).publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  if (await reg.isActive(nodeId)) { console.log(`${label} already active`); continue }

  const nonce = await provider.getTransactionCount(w.address, "latest")
  console.log(`\n${label} ${w.address} nonce=${nonce}`)

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
  const parsed = Transaction.from(signed)
  console.log(`  tx hash: ${parsed.hash}`)

  let any = false
  for (const url of RPCS) {
    try {
      await new JsonRpcProvider(url).broadcastTransaction(signed)
      any = true
    } catch {}
  }
  console.log(`  broadcast: ${any ? "OK" : "ALL REJECTED"}`)

  // Poll receipt up to 90s
  const deadline = Date.now() + 90_000
  let receipt = null
  while (Date.now() < deadline) {
    try {
      receipt = await provider.getTransactionReceipt(parsed.hash)
      if (receipt) break
    } catch {}
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (receipt) {
    console.log(`  ✓ block=${receipt.blockNumber} status=${receipt.status}`)
  } else {
    console.log(`  ✗ no receipt within 90s`)
  }
}

const all = await reg.getActiveValidators()
console.log(`\nfinal active set: ${all.length} validators`)
for (const id of all) console.log(`  - ${id}`)
