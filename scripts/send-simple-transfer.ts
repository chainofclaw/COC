import { ethers } from "ethers"

const RPC = "http://199.192.16.79:28780"
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TO = "0x1111111111111111111111111111111111111111"

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(KEY, provider)

console.log("from:", wallet.address)
const height0 = await provider.getBlockNumber()
console.log("starting height:", height0)
const nonce = await provider.getTransactionCount(wallet.address)
console.log("nonce:", nonce)
const bal0 = await provider.getBalance(wallet.address)
console.log("from balance:", ethers.formatEther(bal0), "ETH")

const gp = ((await provider.getFeeData()).gasPrice ?? 2000000000n) * 2n
console.log("\nsubmitting simple transfer 0.01 ETH → 0x1111...")
const started = Date.now()
try {
  const tx = await wallet.sendTransaction({
    to: TO,
    value: ethers.parseEther("0.01"),
    nonce,
    type: 0,
    gasPrice: gp,
    gasLimit: 21000,
  })
  console.log("tx hash:", tx.hash)
  console.log("waiting for receipt (60s max)...")
  const receipt = await provider.waitForTransaction(tx.hash, 1, 60000)
  const elapsed = Date.now() - started
  if (receipt) {
    console.log(`✓ confirmed in ${elapsed}ms, block=${receipt.blockNumber} status=${receipt.status}`)
  } else {
    console.log(`✗ timed out after ${elapsed}ms`)
  }
} catch (e: any) {
  console.log(`✗ failed after ${Date.now() - started}ms:`, e.message?.slice(0, 200))
}
