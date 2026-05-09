import { Contract, JsonRpcProvider } from "ethers"
import { readFile } from "node:fs/promises"
const RPCS = [
  "http://209.74.64.88:28780",       // upstream validator-1
  "http://159.198.44.136:28780",     // upstream validator-2
  "http://199.192.16.79:28780",      // upstream validator-3
  "http://104.198.192.85:28780",     // anchor-1
]
const REG = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e"
const TXS = [
  "0x71cdb5b34497b37013fdbc65d37efee0b068164108364966c9edbed80dbd5dfa",  // anchor-1 stake
  "0x27112c6b6fd9ca4a46f7845c66f1948d4ffa1d8421ba79b4f24fe5f945b66fbb",  // anchor-2 stake
]
const { abi } = JSON.parse(await readFile("/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json","utf-8"))

for (const rpc of RPCS) {
  console.log(`\n--- ${rpc} ---`)
  try {
    const p = new JsonRpcProvider(rpc)
    const bn = await p.getBlockNumber()
    console.log(`  blockNumber=${bn}`)
    for (const h of TXS) {
      const r = await p.getTransactionReceipt(h)
      if (r) {
        console.log(`  ${h.slice(0,18)}.. status=${r.status} block=${r.blockNumber}`)
      } else {
        const t = await p.getTransaction(h)
        console.log(`  ${h.slice(0,18)}.. ${t ? "in mempool (not mined)" : "unknown"}`)
      }
    }
  } catch (e) {
    console.log(`  error: ${String(e).slice(0,100)}`)
  }
}

// Check current ValidatorRegistry state from upstream
console.log("\n--- ValidatorRegistry state (upstream-1) ---")
const p = new JsonRpcProvider(RPCS[0])
const reg = new Contract(REG, abi, p)
const active = await reg.getActiveValidators()
console.log(`  active count: ${active.length}`)
for (const nid of active) {
  const v = await reg.getValidator(nid)
  console.log(`  nodeId=${nid.slice(0,18)}.. operator=${v.operator} stake=${(v.stake/10n**18n).toString()}ETH active=${v.active}`)
}
