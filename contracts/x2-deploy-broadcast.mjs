// Deploy ValidatorRegistry, broadcast signed tx to ALL 7 RPCs so every
// validator's mempool has it. Avoids the "core has it, ext doesn't" fork
// pattern observed during the X2 cluster recovery.
import { ContractFactory, JsonRpcProvider, Wallet, Transaction } from "ethers"
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
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi, bytecode } = JSON.parse(await readFile(ART, "utf-8"))
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const provider = new JsonRpcProvider(RPCS[0])
const wallet = new Wallet(PK, provider)
const nonce = await provider.getTransactionCount(wallet.address, "latest")
console.log(`deployer ${wallet.address} nonce=${nonce}`)
if (nonce !== 229) {
  console.log(`WARN: nonce is ${nonce}, expected 229. Address won't match 0x162700d1...`)
}

const factory = new ContractFactory(abi, bytecode, wallet)
const deployTx = await factory.getDeployTransaction()
const populated = await wallet.populateTransaction({
  ...deployTx,
  nonce,
  gasLimit: 3_000_000n,
  gasPrice: 5_000_000_000n,
  type: 0,
  chainId: 18780n,
})
const signed = await wallet.signTransaction(populated)
const parsed = Transaction.from(signed)
console.log(`tx hash: ${parsed.hash}`)
console.log(`predicted contract address: ${parsed.from && nonce === 229 ? "0x162700d1613DfEC978032A909DE02643bC55df1A" : "(uncertain)"}`)

console.log("\nbroadcasting to all 7 RPCs...")
for (const url of RPCS) {
  try {
    const p = new JsonRpcProvider(url)
    await p.broadcastTransaction(signed)
    console.log(`  OK  ${url}`)
  } catch (e) {
    const msg = String(e).slice(0, 100)
    console.log(`  -- ${url}: ${msg}`)
  }
}

console.log("\nwaiting for receipt (90s)...")
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  for (const url of RPCS) {
    try {
      const p = new JsonRpcProvider(url)
      const r = await p.getTransactionReceipt(parsed.hash)
      if (r) {
        console.log(`✓ landed via ${url} block=${r.blockNumber} status=${r.status} contract=${r.contractAddress}`)
        process.exit(0)
      }
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 3000))
}
console.log("✗ no receipt within 90s — chain may be stalled. Tx still in mempool.")
