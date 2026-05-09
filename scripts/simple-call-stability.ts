/**
 * Simple-call stability check (post stress-stop, no cron).
 *
 * Fires 10 CidRegistry.registerCid calls one-by-one with a confirm wait,
 * reporting per-tx elapsed time. Designed to exercise repeated on-chain
 * calls against the current 3-node testnet without the cron-stress load,
 * so any recurrence of the runTx hang stands out clearly.
 */
import { ethers } from "ethers"

const RPC = "http://199.192.16.79:28780"
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
// CidRegistry from the most recent deploy (deploy-test-did.ts output).
const CID_REGISTRY = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
const CID_REGISTRY_ABI = [
  "function registerCid(bytes32 cidHash, string cid) external",
  "function resolveCid(bytes32 cidHash) external view returns (string)",
  "function isRegistered(bytes32 cidHash) external view returns (bool)",
]

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(KEY, provider)
const cid = new ethers.Contract(CID_REGISTRY, CID_REGISTRY_ABI, wallet)

console.log(`from: ${wallet.address}`)
console.log(`height0: ${await provider.getBlockNumber()}`)
console.log(`balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH\n`)

const CALLS = 10
const summary = { confirmed: 0, failed: 0, durations: [] as number[] }

for (let i = 0; i < CALLS; i++) {
  const sampleCid = `bafybei${Date.now()}_${i}`
  const cidHash = ethers.keccak256(ethers.toUtf8Bytes(sampleCid))
  const gp = ((await provider.getFeeData()).gasPrice ?? 2000000000n) * 2n
  const started = Date.now()
  try {
    const tx = await cid.registerCid(cidHash, sampleCid, { type: 0, gasPrice: gp, gasLimit: 200000 })
    const r = await provider.waitForTransaction(tx.hash, 1, 45000)
    const ms = Date.now() - started
    if (r?.status === 1) {
      summary.confirmed++
      summary.durations.push(ms)
      console.log(`  [${i + 1}/${CALLS}] ✓ ${ms}ms gasUsed=${r.gasUsed} block=${r.blockNumber}`)
    } else {
      summary.failed++
      console.log(`  [${i + 1}/${CALLS}] ✗ receipt status=${r?.status ?? "timeout"} ms=${ms}`)
    }
  } catch (e: any) {
    summary.failed++
    console.log(`  [${i + 1}/${CALLS}] ✗ error: ${String(e.message).slice(0, 120)}`)
  }
}

const avg = summary.durations.length
  ? Math.round(summary.durations.reduce((a, b) => a + b, 0) / summary.durations.length)
  : 0
const max = summary.durations.length ? Math.max(...summary.durations) : 0
console.log(`\n═══ summary: ${summary.confirmed}/${CALLS} ok, ${summary.failed} failed; avg ${avg}ms max ${max}ms ═══`)
