// Stake node-2 + node-3 from node-1 (deployer) account to bypass mempool stuck-tx.
// Contract allows anyone to stake on behalf of any nodeId (operator = msg.sender).
import { Contract, JsonRpcProvider, Wallet, keccak256, computeAddress, SigningKey } from "ethers"
import { readFile } from "node:fs/promises"

const RPC = "http://199.192.16.79:28780"
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))

const provider = new JsonRpcProvider(RPC)
const DEPLOYER = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider)

// node-2 + node-3 keys (anvil idx 1, 2) — use only their pubkeys, not their wallets.
const TARGETS = [
  { sk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", label: "node-2" },
  { sk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", label: "node-3" },
]

const reg = new Contract(REG, abi, DEPLOYER)
let nonce = await provider.getTransactionCount(DEPLOYER.address, "latest")
console.log(`deployer ${DEPLOYER.address} starting nonce=${nonce}`)

for (const { sk, label } of TARGETS) {
  const pubkey = new SigningKey(sk).publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = keccak256(xy)
  if (await reg.isActive(nodeId)) { console.log(`${label} already active`); continue }
  console.log(`\n${label} nodeId=${nodeId.slice(0, 18)}...`)
  console.log(`  staking from deployer nonce=${nonce}`)
  const tx = await reg.stake(nodeId, pubkey, {
    value: 32n * 10n ** 18n,
    nonce,
    gasLimit: 300_000n,
    gasPrice: 5_000_000_000n,
  })
  console.log(`  tx ${tx.hash}`)
  const r = await Promise.race([
    tx.wait(1),
    new Promise((_, rej) => setTimeout(() => rej(new Error("90s timeout")), 90_000)),
  ]).catch((e) => ({ error: String(e) }))
  if (r.error) { console.log(`  ${r.error}`); break }
  console.log(`  ✓ block=${r.blockNumber} status=${r.status}`)
  nonce++
}

const all = await reg.getActiveValidators()
console.log(`\nfinal active set: ${all.length}`)
for (const id of all) console.log(`  - ${id}`)
