/**
 * Cron stress worker — comprehensive COC testnet stability tests.
 * Called by cron-stress.sh every minute. Outputs a single JSON line.
 *
 * 5-round rotation:
 *   0: ETH transfer
 *   1: EVM computation (eth_call, no tx)
 *   2: Fresh Counter deploy + call (new contract every time)
 *   3: Mempool test (submit tx, check pending, wait confirm)
 *   4: EVM computation (eth_call, no tx)
 *
 * When stalled: only run eth_call rounds (1 or 4).
 */
import { ethers } from "ethers"
import { readFileSync, writeFileSync } from "node:fs"

const RPC_URL = process.argv[2] || "http://127.0.0.1:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CONFIRM_TIMEOUT_S = 15
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
  "function batchRead(uint256 n) view returns (uint256)",
]

interface State { heavyAddr?: string; round: number; lastHeight?: number; deploys?: number }
function loadState(): State { try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")) } catch { return { round: 0, deploys: 0 } } }
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

// --- Round 0: ETH transfer ---
async function roundTransfer(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)
  try {
    const tx = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1000n, type: 0, gasPrice: gp, gasLimit: 21000 })
    const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
    return { sent: 1, confirmed: r?.status === 1 ? 1 : 0, detail: `eth_transfer:gas=${r?.gasUsed ?? "?"}` }
  } catch (e: any) { return { sent: 1, confirmed: 0, detail: `eth_fail:${e.message?.slice(0, 40)}` } }
}

// --- Round 1/4: EVM computation via eth_call ---
async function roundEvmTest(provider: ethers.JsonRpcProvider, state: State): Promise<{ sent: number; confirmed: number; detail: string }> {
  // Deploy HeavyCompute if needed
  if (!state.heavyAddr || !HEAVY_BYTECODE) {
    if (state.heavyAddr) {
      try { const c = await provider.getCode(state.heavyAddr); if (!c || c === "0x") state.heavyAddr = undefined } catch { state.heavyAddr = undefined }
    }
    if (!state.heavyAddr && HEAVY_BYTECODE) {
      const w = new ethers.Wallet(DEPLOYER_KEY, provider)
      const gp = await getGasPrice(provider)
      try {
        const f = new ethers.ContractFactory(HEAVY_ABI, HEAVY_BYTECODE, w)
        const c = await f.deploy({ type: 0, gasPrice: gp, gasLimit: 500000 })
        const r = await waitReceipt(provider, c.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
        if (r?.status === 1 && r.contractAddress) { state.heavyAddr = r.contractAddress; saveState(state) }
      } catch {}
    }
    if (!state.heavyAddr) return { sent: 0, confirmed: 0, detail: "evm:no_contract" }
  }

  const heavy = new ethers.Contract(state.heavyAddr, HEAVY_ABI, provider)
  const t: string[] = []
  let ok = 0

  try { await heavy.fibonacci(100); ok++; t.push("fib") } catch { t.push("fib!") }
  try { await heavy.sortArray(Array.from({ length: 50 }, (_, i) => 50 - i)); ok++; t.push("sort") } catch { t.push("sort!") }
  try { const g = await heavy.hashLoop.estimateGas(10000); ok++; t.push(`hash:${g}`) } catch { t.push("hash!") }
  try { await heavy.memoryExpand(512 * 1024); ok++; t.push("mem") } catch { t.push("mem!") }
  try { await heavy.batchRead(1000); ok++; t.push("read") } catch { t.push("read!") }

  return { sent: 5, confirmed: ok, detail: `evm:${t.join(",")}` }
}

// --- Round 2: Fresh Counter deploy + increment ---
async function roundDeployAndCall(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider, state: State): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)

  // Always deploy a fresh Counter (tests contract creation every time)
  let addr: string | undefined
  try {
    const f = new ethers.ContractFactory(COUNTER_ABI, COUNTER_BYTECODE, wallet)
    const c = await f.deploy({ type: 0, gasPrice: gp, gasLimit: 200000 })
    const r = await waitReceipt(provider, c.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
    if (r?.status === 1 && r.contractAddress) addr = r.contractAddress
  } catch {}
  if (!addr) return { sent: 1, confirmed: 0, detail: "deploy_fail" }

  state.deploys = (state.deploys ?? 0) + 1

  // Call increment() on the fresh contract
  const counter = new ethers.Contract(addr, COUNTER_ABI, wallet)
  try {
    const tx = await counter.increment({ type: 0, gasPrice: gp, gasLimit: 60000 })
    const r = await waitReceipt(provider, tx.hash, CONFIRM_TIMEOUT_S)
    const count = await counter.count().catch(() => "?")
    return { sent: 2, confirmed: r?.status === 1 ? 2 : 1, detail: `deploy+call:${addr.slice(0, 10)},count=${count},total=${state.deploys}` }
  } catch {
    return { sent: 2, confirmed: 1, detail: `deploy_ok_call_fail:${addr.slice(0, 10)}` }
  }
}

// --- Round 3: Mempool test ---
async function roundMempoolTest(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gp = await getGasPrice(provider)
  const checks: string[] = []
  let ok = 0

  // 1. Check initial pending count
  const stats0 = await provider.send("coc_chainStats", []).catch(() => null) as any
  const pending0 = stats0?.pendingTxCount ?? -1
  checks.push(`p0=${pending0}`)

  // 2. Send a tx
  let txHash: string | undefined
  try {
    const tx = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, type: 0, gasPrice: gp, gasLimit: 21000 })
    txHash = tx.hash
  } catch (e: any) {
    return { sent: 1, confirmed: 0, detail: `mempool:send_fail:${e.message?.slice(0, 30)}` }
  }

  // 3. Check pending increased
  await new Promise(r => setTimeout(r, 500))
  const stats1 = await provider.send("coc_chainStats", []).catch(() => null) as any
  const pending1 = stats1?.pendingTxCount ?? -1
  if (pending1 > pending0) { ok++; checks.push(`p1=${pending1}+`) } else { checks.push(`p1=${pending1}`) }

  // 4. Check tx in pending via getTransactionByHash (blockNumber should be null)
  const pendingTx = await provider.getTransaction(txHash!).catch(() => null)
  if (pendingTx && pendingTx.blockNumber === null) { ok++; checks.push("inpool") } else { checks.push("nopool") }

  // 5. Wait for confirmation
  const receipt = await waitReceipt(provider, txHash!, CONFIRM_TIMEOUT_S)
  if (receipt?.status === 1) { ok++; checks.push(`mined:${receipt.blockNumber}`) } else { checks.push("timeout") }

  // 6. Check pending decreased after mining
  const stats2 = await provider.send("coc_chainStats", []).catch(() => null) as any
  const pending2 = stats2?.pendingTxCount ?? -1
  if (pending2 <= pending0) { ok++; checks.push(`p2=${pending2}ok`) } else { checks.push(`p2=${pending2}`) }

  return { sent: 4, confirmed: ok, detail: `mempool:${checks.join(",")}` }
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
  const prevHeight = state.lastHeight ?? 0
  const stalled = height > 0 && height === prevHeight
  state.lastHeight = height

  // 7-round rotation: mostly eth_call with occasional on-chain txs.
  // Reduces BFT nonce-conflict risk by spacing out on-chain operations.
  // Stalled → eth_call only.
  const round = stalled ? 1 : (state.round % 7)

  let result: { sent: number; confirmed: number; detail: string }
  try {
    switch (round) {
      case 0: result = await roundTransfer(wallet, provider); break
      case 1: result = await roundEvmTest(provider, state); break
      case 2: result = await roundEvmTest(provider, state); break
      case 3: result = await roundDeployAndCall(wallet, provider, state); break
      case 4: result = await roundEvmTest(provider, state); break
      case 5: result = await roundEvmTest(provider, state); break
      case 6: result = await roundMempoolTest(wallet, provider); break
      default: result = { sent: 0, confirmed: 0, detail: "unknown_round" }
    }
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
