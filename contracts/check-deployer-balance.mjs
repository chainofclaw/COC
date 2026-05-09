import { JsonRpcProvider, formatEther } from "ethers"
const p = new JsonRpcProvider("http://104.198.192.85:28780")
const dep = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const bal = await p.getBalance(dep)
console.log(`deployer ${dep} balance: ${formatEther(bal)} ETH`)
console.log(`need 5 × 32 = 160 ETH for stake; +5 × 32 ETH funding tx`)
