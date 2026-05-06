import { Contract, JsonRpcProvider } from "ethers"
import { readFile } from "node:fs/promises"
const RPC = "http://199.192.16.79:28782"
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))
const provider = new JsonRpcProvider(RPC)
const reg = new Contract(REG, abi, provider)
const all = await reg.getActiveValidators()
console.log(`active set: ${all.length} validators`)
for (const id of all) console.log(`  - ${id} → ${("0x" + id.slice(-40)).toLowerCase()}`)
