import { JsonRpcProvider, Wallet, ethers } from "ethers"
const provider = new JsonRpcProvider("http://209.74.64.88:28780")
const w = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider)
const dst = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const gp = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
let nonce = await provider.getTransactionCount(w.address, "pending")
const txs = []
for (let i = 0; i < 5; i++) {
  const t = await w.sendTransaction({ to: dst, value: ethers.parseEther("0.0001"), nonce: nonce+i, gasPrice: gp, type: 0, gasLimit: 21000 })
  txs.push(t.hash)
}
const blocks = new Set()
for (const h of txs) {
  const r = await provider.waitForTransaction(h, 1, 30000)
  blocks.add(r.blockNumber)
}
console.log(`5 txs landed in blocks: ${[...blocks].sort((a,b)=>a-b).join(', ')}`)
