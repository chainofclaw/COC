// Broadcast stake txs to ALL 3 RPC endpoints with high gas to force inclusion.
import { Contract, JsonRpcProvider, Wallet, keccak256, Transaction } from "ethers"
import { readFile } from "node:fs/promises"

const RPCS = [
  "http://199.192.16.79:28780",
  "http://199.192.16.79:28782",
  "http://199.192.16.79:28784",
]
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))

const provider = new JsonRpcProvider(RPCS[0])

const KEYS = [
  ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "node-2"],
  ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "node-3"],
]

for (const [pk, label] of KEYS) {
  const w = new Wallet(pk, provider)
  const pubkey = w.signingKey.publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  const reg = new Contract(REG, abi, provider)
  if (await reg.isActive(nodeId)) { console.log(`${label} already active`); continue }

  // Use the LATEST nonce (mined) to displace any stuck pending tx at that slot.
  const nonce = await provider.getTransactionCount(w.address, "latest")
  console.log(`\n${label} ${w.address}`)
  console.log(`  nonce=${nonce} (using LATEST to replace stuck pending)`)

  // Encode stake() calldata
  const iface = new Contract(REG, abi, provider).interface
  const data = iface.encodeFunctionData("stake", [nodeId, pubkey])

  const txReq = {
    chainId: 18780,
    to: REG,
    data,
    value: 32n * 10n ** 18n,
    nonce,
    gasLimit: 250_000n,
    type: 0,             // legacy tx — chain seems to prefer it
    gasPrice: 1_000_000_000_000n,  // 1000 gwei — guaranteed to beat any incumbent
  }

  const signed = await w.signTransaction(txReq)
  const parsed = Transaction.from(signed)
  console.log(`  signed tx: ${parsed.hash}`)

  // Broadcast to ALL 3 RPCs
  for (const rpcUrl of RPCS) {
    try {
      const p = new JsonRpcProvider(rpcUrl)
      await p.broadcastTransaction(signed)
      console.log(`  broadcast OK via ${rpcUrl}`)
    } catch (e) {
      const msg = String(e).slice(0, 120)
      console.log(`  ${rpcUrl}: ${msg}`)
    }
  }

  // Poll receipt across peers for up to 60s
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const rpcUrl of RPCS) {
      try {
        const p = new JsonRpcProvider(rpcUrl)
        const r = await p.getTransactionReceipt(parsed.hash)
        if (r) { console.log(`  ✓ landed block=${r.blockNumber} status=${r.status} via ${rpcUrl}`); break }
      } catch {}
    }
    if (await reg.isActive(nodeId)) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!await reg.isActive(nodeId)) console.log(`  ✗ ${label} did not land within 60s`)
}

const reg = new Contract(REG, abi, provider)
const all = await reg.getActiveValidators()
console.log(`\nfinal active set: ${all.length}`)
for (const id of all) console.log(`  - ${("0x" + id.slice(-40)).toLowerCase()}`)
