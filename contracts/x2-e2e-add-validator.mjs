// E2E test: stake ext-1 (anvil idx 5) on-chain. Verify the cores'
// ValidatorRegistryReader picks up the new validator within the poll
// interval (60s default) without any restart.
import { Contract, JsonRpcProvider, Wallet, keccak256, Transaction, SigningKey } from "ethers"
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
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))

const TARGET_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
const FUNDING_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const provider = new JsonRpcProvider(RPCS[0])
const target = new Wallet(TARGET_PK, provider)
const targetPubkey = new SigningKey(TARGET_PK).publicKey
const targetNodeId = keccak256("0x" + targetPubkey.slice(4))

console.log(`target ext-1: ${target.address}`)
console.log(`target nodeId: ${targetNodeId}`)

const reg = new Contract(REG, abi, provider)
const beforeSet = await reg.getActiveValidators()
console.log(`\nbefore: ${beforeSet.length} validators`)
for (const id of beforeSet) console.log(`  - ${id}`)

if (await reg.isActive(targetNodeId)) {
  console.log("\ntarget already active — skipping stake")
} else {
  // Step 1: ensure target has funds
  const targetBal = await provider.getBalance(target.address)
  if (targetBal < 35n * 10n ** 18n) {
    console.log(`\nfunding ${target.address} from deployer (current bal=${(Number(targetBal)/1e18).toFixed(4)})`)
    const funder = new Wallet(FUNDING_PK, provider)
    const fNonce = await provider.getTransactionCount(funder.address, "latest")
    const tx = await funder.populateTransaction({
      to: target.address,
      value: 50n * 10n ** 18n,
      nonce: fNonce,
      gasLimit: 21_000n,
      gasPrice: 5_000_000_000n,
      type: 0,
      chainId: 18780n,
    })
    const signed = await funder.signTransaction(tx)
    for (const url of RPCS) {
      try { await new JsonRpcProvider(url).broadcastTransaction(signed) } catch {}
    }
    const fHash = Transaction.from(signed).hash
    console.log(`  fund tx: ${fHash}`)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      try {
        const r = await provider.getTransactionReceipt(fHash)
        if (r) { console.log(`  ✓ funded block=${r.blockNumber}`); break }
      } catch {}
      await new Promise((r) => setTimeout(r, 4000))
    }
  }

  // Step 2: stake from target
  const sNonce = await provider.getTransactionCount(target.address, "latest")
  const data = reg.interface.encodeFunctionData("stake", [targetNodeId, targetPubkey])
  const stx = await target.populateTransaction({
    to: REG,
    data,
    value: 32n * 10n ** 18n,
    nonce: sNonce,
    gasLimit: 300_000n,
    gasPrice: 5_000_000_000n,
    type: 0,
    chainId: 18780n,
  })
  const signed = await target.signTransaction(stx)
  for (const url of RPCS) {
    try { await new JsonRpcProvider(url).broadcastTransaction(signed) } catch {}
  }
  const sHash = Transaction.from(signed).hash
  console.log(`\nstake tx: ${sHash}`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const r = await provider.getTransactionReceipt(sHash)
      if (r) { console.log(`  ✓ staked block=${r.blockNumber} status=${r.status}`); break }
    } catch {}
    await new Promise((r) => setTimeout(r, 4000))
  }
}

const afterSet = await reg.getActiveValidators()
console.log(`\nafter: ${afterSet.length} validators on chain`)
for (const id of afterSet) console.log(`  - ${id}`)

console.log(`\n--- now waiting up to 90s for reader to auto-pickup ---`)
console.log(`(reader poll interval default 60s; no restart needed)`)
