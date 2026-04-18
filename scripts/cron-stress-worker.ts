/**
 * Cron stress worker — tests COC testnet stability via:
 *   Round 0: Single ETH transfer (on-chain tx)
 *   Round 1: EVM computation tests via eth_call (no tx, no stall risk)
 *   Round 2: Deploy Counter if needed, then single increment() call
 *
 * Outputs a single JSON line. Called by cron-stress.sh every minute.
 */
import { ethers } from "ethers"
import { readFileSync, writeFileSync } from "node:fs"

const RPC_URL = process.argv[2] || "http://127.0.0.1:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CONFIRM_TIMEOUT_S = 15
const STATE_PATH = "/tmp/coc-stress-contracts.json"

// --- Embedded artifacts ---
const COUNTER_BYTECODE = "0x608080604052346100155760ea908161001b8239f35b600080fdfe6080806040526004361015601257600080fd5b600090813560e01c90816306661abd146098575063d09de08a14603457600080fd5b3460955780600319360112609557805460001981146081576001018082556040519081527f38ac789ed44572701765277c4d0970f2db1c1a571ed39e84358095ae4eaa542060203392a280f35b634e487b7160e01b82526011600452602482fd5b80fd5b90503460b0578160031936011260b057602091548152f35b5080fdfea26469706673582212200601b4a0ea9a382d6b93facedeb52573bce750d3c0caad9dc838e0429eb5861b64736f6c63430008180033"
const COUNTER_ABI = ["function increment()", "function count() view returns (uint256)"]

// HeavyCompute bytecode loaded from file (too large to embed)
let HEAVY_BYTECODE = ""
try { HEAVY_BYTECODE = readFileSync("/root/coc-stress/heavy-bytecode.txt", "utf-8").trim() } catch { /* will skip deploy */ }
const HEAVY_ABI = [
  "function fibonacci(uint256 n) view returns (uint256)",
  "function sortArray(uint256[] arr) pure returns (uint256[])",
  "function hashLoop(uint256 n) returns (bytes32)",
  "function memoryExpand(uint256 sizeBytes) pure returns (uint256)",
  "function batchWrite(uint256 n) external",
  "function batchRead(uint256 n) view returns (uint256)",
  "function combinedStress(uint256 writeCount, uint256 hashCount) returns (uint256, bytes32)",
]

// --- State ---
interface State { counterAddr?: string; heavyAddr?: string; round: number; lastHeight?: number }
function loadState(): State { try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")) } catch { return { round: 0 } } }
function saveState(s: State) { writeFileSync(STATE_PATH, JSON.stringify(s)) }

// --- Helpers ---
async function waitReceipt(provider: ethers.JsonRpcProvider, hash: string, timeoutS: number): Promise<ethers.TransactionReceipt | null> {
  const deadline = Date.now() + timeoutS * 1000
  while (Date.now() < deadline) {
    const r = await provider.getTransactionReceipt(hash).catch(() => null)
    if (r) return r
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return null
}

async function getGasPrice(provider: ethers.JsonRpcProvider): Promise<bigint> {
  const fee = await provider.getFeeData()
  return (fee.gasPrice ?? 2000000000n) * 2n
}

// --- Round 0: Single ETH transfer ---
async function roundTransfer(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gasPrice = await getGasPrice(provider)
  try {
    const tx = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1000n, type: 0, gasPrice, gasLimit: 21000 })
    const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
    return { sent: 1, confirmed: r?.status === 1 ? 1 : 0, detail: "eth_transfer" }
  } catch { return { sent: 1, confirmed: 0, detail: "eth_transfer_fail" } }
}

// --- Round 1: EVM computation via eth_call (no tx, zero stall risk) ---
async function roundEvmTest(provider: ethers.JsonRpcProvider, state: State): Promise<{ sent: number; confirmed: number; detail: string }> {
  // Deploy HeavyCompute if not deployed
  if (!state.heavyAddr) {
    const wallet = new ethers.Wallet(DEPLOYER_KEY, provider)
    const gasPrice = await getGasPrice(provider)
    try {
      const factory = new ethers.ContractFactory(HEAVY_ABI, HEAVY_BYTECODE, wallet)
      const c = await factory.deploy({ type: 0, gasPrice, gasLimit: 500000 })
      const r = await waitReceipt(provider, c.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
      if (r?.status === 1 && r.contractAddress) {
        state.heavyAddr = r.contractAddress
        saveState(state)
        return { sent: 1, confirmed: 1, detail: `heavy_deploy:${r.contractAddress.slice(0, 10)}` }
      }
    } catch { /* deploy failed */ }
    return { sent: 1, confirmed: 0, detail: "heavy_deploy_fail" }
  }

  const heavy = new ethers.Contract(state.heavyAddr, HEAVY_ABI, provider)
  const tests: string[] = []
  let passed = 0

  // fibonacci(100) — CPU test
  try { await heavy.fibonacci(100); passed++; tests.push("fib100") } catch { tests.push("fib100!") }

  // sortArray(50) — O(n^2) loop
  try { await heavy.sortArray(Array.from({ length: 50 }, (_, i) => 50 - i)); passed++; tests.push("sort50") } catch { tests.push("sort50!") }

  // hashLoop — estimate gas for 10000 iterations
  try { const g = await heavy.hashLoop.estimateGas(10000); passed++; tests.push(`hash10k:${g}`) } catch { tests.push("hash10k!") }

  // memoryExpand(512KB)
  try { await heavy.memoryExpand(512 * 1024); passed++; tests.push("mem512k") } catch { tests.push("mem512k!") }

  // batchRead(1000) — storage read
  try { await heavy.batchRead(1000); passed++; tests.push("read1k") } catch { tests.push("read1k!") }

  return { sent: 5, confirmed: passed, detail: `evm:${tests.join(",")}` }
}

// --- Round 2: Counter contract deploy/call ---
async function roundCounter(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider, state: State): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gasPrice = await getGasPrice(provider)

  if (!state.counterAddr) {
    try {
      const factory = new ethers.ContractFactory(COUNTER_ABI, COUNTER_BYTECODE, wallet)
      const c = await factory.deploy({ type: 0, gasPrice, gasLimit: 200000 })
      const r = await waitReceipt(provider, c.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
      if (r?.status === 1 && r.contractAddress) {
        state.counterAddr = r.contractAddress
        saveState(state)
        return { sent: 1, confirmed: 1, detail: `counter_deploy:${r.contractAddress.slice(0, 10)}` }
      }
    } catch { /* deploy failed */ }
    return { sent: 1, confirmed: 0, detail: "counter_deploy_fail" }
  }

  // Single increment()
  const counter = new ethers.Contract(state.counterAddr, COUNTER_ABI, wallet)
  try {
    const tx = await counter.increment({ type: 0, gasPrice, gasLimit: 60000 })
    const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
    const count = await counter.count().catch(() => "?")
    return { sent: 1, confirmed: r?.status === 1 ? 1 : 0, detail: `counter:${count}` }
  } catch {
    return { sent: 1, confirmed: 0, detail: "counter_call_fail" }
  }
}

// --- Main ---
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider)

  let height: number, peers: number
  try {
    height = await provider.getBlockNumber()
    peers = parseInt(await provider.send("net_peerCount", []) as string, 16)
  } catch {
    console.log(JSON.stringify({ status: "UNREACHABLE", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?", detail: "" }))
    return
  }

  const state = loadState()

  // Check if chain is advancing — if stalled, only run eth_call tests (round 1)
  // which don't require on-chain transactions and can't make things worse.
  const prevHeight = state.lastHeight ?? 0
  const stalled = height > 0 && height === prevHeight
  state.lastHeight = height

  // Round rotation: ETH transfer (1 tx) → EVM eth_call → EVM eth_call
  // Only 1 on-chain tx every 3 minutes to minimize BFT stall risk.
  // When stalled, only run eth_call tests (no tx, can't make things worse).
  const round = stalled ? 1 : (state.round % 3)

  let result: { sent: number; confirmed: number; detail: string }
  try {
    if (round === 0) result = await roundTransfer(wallet, provider)
    else result = await roundEvmTest(provider, state)
  } catch (e) {
    result = { sent: 0, confirmed: 0, detail: `error:${String(e).slice(0, 50)}` }
  }

  if (!stalled) state.round = state.round + 1
  saveState(state)

  const finalHeight = await provider.getBlockNumber()
  let sync = "ok"
  for (const port of [28780, 28782, 28784]) {
    try {
      const h = await new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`).getBlockNumber()
      if (Math.abs(finalHeight - h) > 2) sync = "desync"
    } catch { sync = "partial" }
  }

  let status = "OK"
  if (result.confirmed < result.sent) status = "PARTIAL"
  if (result.sent === 0) status = "SEND_FAIL"
  if (sync === "desync") status = "DESYNC"

  console.log(JSON.stringify({ status, height: finalHeight, blocks: finalHeight - height, sent: result.sent, confirmed: result.confirmed, peers, sync, detail: result.detail }))
}

main().catch(() => {
  console.log(JSON.stringify({ status: "CRASH", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?", detail: "" }))
})
