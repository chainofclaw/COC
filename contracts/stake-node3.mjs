import { Contract, JsonRpcProvider, Wallet, keccak256 } from "ethers"
import { readFile } from "node:fs/promises"
const RPC = "http://199.192.16.79:28782"
const REG = "0x162700d1613DfEC978032A909DE02643bC55df1A"
const ART = "/passinger/projects/ClawdBot/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"
const { abi } = JSON.parse(await readFile(ART, "utf-8"))
const provider = new JsonRpcProvider(RPC)
const w = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", provider)
const pubkey = w.signingKey.publicKey
const xy = "0x" + pubkey.slice(4)
const nodeId = keccak256(xy)
const reg = new Contract(REG, abi, w)
console.log(`staking node-3 ${w.address} nodeId=${nodeId}`)
const nonce = await provider.getTransactionCount(w.address, "latest")
console.log(`nonce=${nonce}`)
const tx = await reg.stake(nodeId, pubkey, { value: 32n * 10n ** 18n, nonce, gasLimit: 250_000n, gasPrice: 8_000_000_000n })
console.log(`tx=${tx.hash}`)
const r = await Promise.race([tx.wait(1), new Promise((_, rej) => setTimeout(() => rej(new Error("60s timeout")), 60_000))]).catch(e => ({ error: String(e) }))
console.log(r.error || `block=${r.blockNumber} status=${r.status}`)
