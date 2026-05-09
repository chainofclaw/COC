import { Contract, JsonRpcProvider } from "ethers"
import { readFile } from "node:fs/promises"
const RPC = "http://104.198.192.85:28780"  // anchor-1
const REG = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e"
const { abi } = JSON.parse(await readFile("/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json","utf-8"))
const provider = new JsonRpcProvider(RPC)
const reg = new Contract(REG, abi, provider)
const active = await reg.getActiveValidators()
console.log("Active validators on ValidatorRegistry:", active.length)
for (const nid of active) {
  const v = await reg.getValidator(nid)
  console.log(`  nodeId=${nid}\n    operator=${v.operator}\n    stake=${(v.stake/10n**18n).toString()} ETH\n    active=${v.active}`)
}
const min = await reg.MIN_STAKE()
const maxV = await reg.MAX_VALIDATORS()
console.log(`MIN_STAKE=${min/10n**18n}ETH MAX_VALIDATORS=${maxV}`)
