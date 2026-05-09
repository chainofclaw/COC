import { JsonRpcProvider, Wallet, Transaction } from "ethers"
const provider = new JsonRpcProvider("https://clawchain.io/api/testnet/rpc")
const w = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider)  // anvil-0
const nonce = await provider.getTransactionCount(w.address, "latest")
console.log("anvil-0 nonce=", nonce)
const tx = await w.populateTransaction({
  to: "0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF",
  value: 1000n * 10n ** 18n,
  nonce,
  gasLimit: 21000n,
  gasPrice: 5_000_000_000n,
  type: 0,
  chainId: 18780n,
})
const signed = await w.signTransaction(tx)
const hash = Transaction.from(signed).hash
console.log("tx hash:", hash)
await provider.broadcastTransaction(signed)
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000))
  const r = await provider.getTransactionReceipt(hash)
  if (r) { console.log(`✓ MINED block=${r.blockNumber} status=${r.status}`); break }
  process.stdout.write(".")
}
const finalBal = await provider.getBalance("0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF")
console.log(`faucet balance after fund: ${finalBal}`)
