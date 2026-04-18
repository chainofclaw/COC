/**
 * Cron stress worker — high-intensity COC testnet stability tests.
 * Called by cron-stress.sh every minute. Outputs a single JSON line.
 *
 * 5-round rotation (all rounds execute on-chain txs now):
 *   0: Batch ETH transfers (5 txs, pre-assigned nonces)
 *   1: EVM computation (eth_call 5 checks) + 1 on-chain batchWrite
 *   2: Fresh Counter deploy + 3 increments
 *   3: Mempool lifecycle test + multi-value transfer
 *   4: Multi-wallet parallel transfers (3 wallets, 1 tx each)
 *
 * When stalled: only run eth_call tests.
 */
import { ethers } from "ethers"
import { readFileSync, writeFileSync } from "node:fs"

const RPC_URL = process.argv[2] || "http://127.0.0.1:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CONFIRM_TIMEOUT_S = 20
const STATE_PATH = "/tmp/coc-stress-contracts.json"

const COUNTER_BYTECODE = "0x608080604052346100155760ea908161001b8239f35b600080fdfe6080806040526004361015601257600080fd5b600090813560e01c90816306661abd146098575063d09de08a14603457600080fd5b3460955780600319360112609557805460001981146081576001018082556040519081527f38ac789ed44572701765277c4d0970f2db1c1a571ed39e84358095ae4eaa542060203392a280f35b634e487b7160e01b82526011600452602482fd5b80fd5b90503460b0578160031936011260b057602091548152f35b5080fdfea26469706673582212200601b4a0ea9a382d6b93facedeb52573bce750d3c0caad9dc838e0429eb5861b64736f6c63430008180033"
const COUNTER_ABI = ["function increment()", "function count() view returns (uint256)"]

let HEAVY_BYTECODE = ""
try { HEAVY_BYTECODE = readFileSync("/root/coc-stress/heavy-bytecode.txt", "utf-8").trim() } catch {}
const HEAVY_ABI = [
  "function fibonacci(uint256 n) view returns (uint256)",
  "function sortArray(uint256[] arr) pure returns (uint256[])",
  "function hashLoop(uint256 n) returns (bytes32)",
  "function memoryExpand(uint256 sizeBytes) pure returns (uint256)",
  "function batchWrite(uint256 n) external",
  "function batchRead(uint256 n) view returns (uint256)",
]

interface State { heavyAddr?: string; round: number; lastHeight?: number; deploys?: number; totalTxs?: number }
function loadState(): State { try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")) } catch { return { round: 0, deploys: 0, totalTxs: 0 } } }
function saveState(s: State) { writeFileSync(STATE_PATH, JSON.stringify(s)) }

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
  return ((await provider.getFeeData()).gasPrice ?? 2000000000n) * 2n
}

async function ensureHeavy(provider: ethers.JsonRpcProvider, state: State): Promise<string | null> {
  if (state.heavyAddr) {
    try { const c = await provider.getCode(state.heavyAddr); if (c && c !== "0x") return state.heavyAddr } catch {}
    state.heavyAddr = undefined
  }
  if (!HEAVY_BYTECODE) return null
  const w = new ethers.Wallet(DEPLOYER_KEY, provider)
  const gp = await getGasPrice(provider)
  try {
    const f = new ethers.ContractFactory(HEAVY_ABI, HEAVY_BYTECODE, w)
    const c = await f.deploy({ type: 0, gasPrice: gp, gasLimit: 500000 })
    const r = await waitReceipt(provider, c.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
    if (r?.status === 1 && r.contractAddress) { state.heavyAddr = r.contractAddress; saveState(state); return r.contractAddress }
  } catch {}
  return null
}

// === Round 0: Batch ETH transfers (5 txs) ===
async function round0(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)
  const nonce = await provider.getTransactionCount(wallet.address)
  const hashes: string[] = []
  for (let i = 0; i < 5; i++) {
    try {
      const tx = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1000n + BigInt(i), nonce: nonce + i, type: 0, gasPrice: gp, gasLimit: 21000 })
      hashes.push(tx.hash)
    } catch { break }
  }
  let ok = 0
  for (const h of hashes) { if ((await waitReceipt(provider, h, CONFIRM_TIMEOUT_S))?.status === 1) ok++ }
  return { sent: hashes.length, confirmed: ok, detail: `batch_eth:${ok}/${hashes.length}` }
}

// === Round 1: EVM eth_call + on-chain batchWrite ===
async function round1(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider, state: State): Promise<{ sent: number; confirmed: number; detail: string }> {
  const addr = await ensureHeavy(provider, state)
  if (!addr) return { sent: 0, confirmed: 0, detail: "evm:no_contract" }

  const heavy = new ethers.Contract(addr, HEAVY_ABI, provider)
  const t: string[] = []
  let ok = 0

  try { await heavy.fibonacci(100); ok++; t.push("fib") } catch { t.push("fib!") }
  try { await heavy.sortArray(Array.from({ length: 50 }, (_, i) => 50 - i)); ok++; t.push("sort") } catch { t.push("sort!") }
  try { const g = await heavy.hashLoop.estimateGas(10000); ok++; t.push(`hash:${g}`) } catch { t.push("hash!") }
  try { await heavy.memoryExpand(512 * 1024); ok++; t.push("mem") } catch { t.push("mem!") }
  try { await heavy.batchRead(1000); ok++; t.push("read") } catch { t.push("read!") }

  // On-chain batchWrite(50) — test contract storage writes
  const gp = await getGasPrice(provider)
  const heavyW = new ethers.Contract(addr, HEAVY_ABI, wallet)
  try {
    const tx = await heavyW.batchWrite(50, { type: 0, gasPrice: gp, gasLimit: 1500000 })
    const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
    if (r?.status === 1) { ok++; t.push(`write50:${r.gasUsed}`) } else { t.push("write50!") }
  } catch { t.push("write50!") }

  return { sent: 6, confirmed: ok, detail: `evm:${t.join(",")}` }
}

// === Round 2: Fresh Counter deploy + 3 increments ===
async function round2(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider, state: State): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)
  let addr: string | undefined
  try {
    const f = new ethers.ContractFactory(COUNTER_ABI, COUNTER_BYTECODE, wallet)
    const c = await f.deploy({ type: 0, gasPrice: gp, gasLimit: 200000 })
    const r = await waitReceipt(provider, c.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
    if (r?.status === 1 && r.contractAddress) addr = r.contractAddress
  } catch {}
  if (!addr) return { sent: 1, confirmed: 0, detail: "deploy_fail" }

  state.deploys = (state.deploys ?? 0) + 1
  const counter = new ethers.Contract(addr, COUNTER_ABI, wallet)
  let ok = 1 // deploy counted
  let sent = 1

  // 3 sequential increments
  for (let i = 0; i < 3; i++) {
    sent++
    try {
      const tx = await counter.increment({ type: 0, gasPrice: gp, gasLimit: 60000 })
      const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
      if (r?.status === 1) ok++
      else break
    } catch { break }
  }

  const count = await counter.count().catch(() => "?")
  return { sent, confirmed: ok, detail: `deploy+3inc:${addr.slice(0, 10)},count=${count},total=${state.deploys}` }
}

// === Round 3: Mempool lifecycle + transfer ===
async function round3(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)
  const checks: string[] = []
  let ok = 0

  const stats0 = await provider.send("coc_chainStats", []).catch(() => null) as any
  checks.push(`p0=${stats0?.pendingTxCount ?? "?"}`)

  // Send tx
  let txHash: string | undefined
  try {
    const tx = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, type: 0, gasPrice: gp, gasLimit: 21000 })
    txHash = tx.hash
  } catch { return { sent: 1, confirmed: 0, detail: `mempool:send_fail` } }

  await new Promise(r => setTimeout(r, 500))
  const stats1 = await provider.send("coc_chainStats", []).catch(() => null) as any
  if ((stats1?.pendingTxCount ?? 0) > (stats0?.pendingTxCount ?? 0)) { ok++; checks.push("pending+") } else { checks.push("pending=") }

  const pendingTx = await provider.getTransaction(txHash!).catch(() => null)
  if (pendingTx && pendingTx.blockNumber === null) { ok++; checks.push("inpool") } else { checks.push("nopool") }

  const receipt = await waitReceipt(provider, txHash!, CONFIRM_TIMEOUT_S)
  if (receipt?.status === 1) { ok++; checks.push(`mined:${receipt.blockNumber}`) } else { checks.push("timeout") }

  // Second transfer after confirm
  try {
    const tx2 = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 2n, type: 0, gasPrice: gp, gasLimit: 21000 })
    const r2 = await waitReceipt(provider, tx2.hash, CONFIRM_TIMEOUT_S)
    if (r2?.status === 1) { ok++; checks.push("tx2ok") } else { checks.push("tx2fail") }
  } catch { checks.push("tx2err") }

  return { sent: 4, confirmed: ok, detail: `mempool:${checks.join(",")}` }
}

// === Round 4: Multi-wallet parallel transfers ===
async function round4(provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)
  const mainWallet = new ethers.Wallet(DEPLOYER_KEY, provider)

  // Create 3 funded wallets
  const wallets: ethers.Wallet[] = []
  for (let i = 0; i < 3; i++) {
    wallets.push(ethers.Wallet.createRandom().connect(provider))
  }

  // Fund them
  const nonce = await provider.getTransactionCount(mainWallet.address)
  let funded = 0
  for (let i = 0; i < 3; i++) {
    try {
      const tx = await mainWallet.sendTransaction({ to: wallets[i].address, value: ethers.parseEther("0.1"), nonce: nonce + i, type: 0, gasPrice: gp, gasLimit: 21000 })
      const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
      if (r?.status === 1) funded++
    } catch { break }
  }
  if (funded < 3) return { sent: 3, confirmed: funded, detail: `multi:funded=${funded}/3` }

  // Each wallet sends 1 tx in parallel
  const hashes: string[] = []
  await Promise.all(wallets.map(async (w) => {
    try {
      const tx = await w.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1000n, type: 0, gasPrice: gp, gasLimit: 21000 })
      hashes.push(tx.hash)
    } catch {}
  }))

  let ok = 0
  for (const h of hashes) { if ((await waitReceipt(provider, h, CONFIRM_TIMEOUT_S))?.status === 1) ok++ }
  return { sent: 3 + hashes.length, confirmed: funded + ok, detail: `multi:fund=${funded},par=${ok}/${hashes.length}` }
}

// === Main ===
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
  const prevHeight = state.lastHeight ?? 0
  const stalled = height > 0 && height === prevHeight
  state.lastHeight = height

  const round = stalled ? -1 : (state.round % 5) // -1 = eth_call only

  let result: { sent: number; confirmed: number; detail: string }
  try {
    switch (round) {
      case 0: result = await round0(wallet, provider); break
      case 1: result = await round1(wallet, provider, state); break
      case 2: result = await round2(wallet, provider, state); break
      case 3: result = await round3(wallet, provider); break
      case 4: result = await round4(provider); break
      default: {
        // Stalled — eth_call only
        const addr = state.heavyAddr
        if (addr) {
          const heavy = new ethers.Contract(addr, HEAVY_ABI, provider)
          let ok = 0
          try { await heavy.fibonacci(100); ok++ } catch {}
          try { await heavy.sortArray(Array.from({ length: 50 }, (_, i) => 50 - i)); ok++ } catch {}
          try { await heavy.memoryExpand(512 * 1024); ok++ } catch {}
          result = { sent: 3, confirmed: ok, detail: `stall_evm:${ok}/3` }
        } else { result = { sent: 0, confirmed: 0, detail: "stall:no_contract" } }
      }
    }
  } catch (e) {
    result = { sent: 0, confirmed: 0, detail: `error:${String(e).slice(0, 50)}` }
  }

  if (!stalled) state.round = state.round + 1
  state.totalTxs = (state.totalTxs ?? 0) + result.confirmed
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
  if (result.sent === 0 && round >= 0) status = "SEND_FAIL"
  if (sync === "desync") status = "DESYNC"

  console.log(JSON.stringify({ status, height: finalHeight, blocks: finalHeight - height, sent: result.sent, confirmed: result.confirmed, peers, sync, detail: result.detail }))
}

main().catch(() => {
  console.log(JSON.stringify({ status: "CRASH", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?", detail: "" }))
})
