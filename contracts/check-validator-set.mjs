import { JsonRpcProvider, Contract, formatEther } from "ethers"
const RPC = process.env.RPC || "http://209.74.64.88:28780"
const REG = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e"
const ABI = [
  "function getActiveValidators() external view returns (bytes32[])",
  "function activeValidatorCount() external view returns (uint256)",
  "function getValidator(bytes32 nodeId) external view returns (tuple(bytes32 nodeId, address operator, uint256 stake, uint64 registeredAt, uint64 unstakeRequestedAt, bool active))",
]
const provider = new JsonRpcProvider(RPC)
const c = new Contract(REG, ABI, provider)
const ids = await c.getActiveValidators()
const count = await c.activeValidatorCount()
console.log(`# ValidatorRegistry @ ${REG}`)
console.log(`  active count: ${count}`)
console.log(`  active set:`)
for (let i = 0; i < ids.length; i++) {
  const v = await c.getValidator(ids[i])
  const trail20 = "0x" + ids[i].slice(-40)
  console.log(`    [${i}] nodeId=${ids[i]}`)
  console.log(`        addr=${trail20}  operator=${v.operator}  stake=${formatEther(v.stake)} ETH  active=${v.active}  registeredAt=${new Date(Number(v.registeredAt)*1000).toISOString()}`)
}
