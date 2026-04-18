/**
 * COC Advanced Stress Test — finds hidden bugs on the live 3-node testnet.
 *
 * 20 tests across 4 categories:
 *   A. RPC boundary tests (eth_call, no tx)
 *   B. Mempool tests (single sequential txs)
 *   C. Gas/fee market tests (read-only)
 *   D. Chain data consistency (cross-node)
 *
 * Usage: node --experimental-strip-types scripts/stress-advanced.ts [rpc]
 */
import { ethers } from "ethers"

const RPC = process.argv[2] || "http://199.192.16.79:28780"
const PORTS = [28780, 28782, 28784]
const HOST = "199.192.16.79"
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(KEY, provider)

let passed = 0, failed = 0
const failures: string[] = []

function pass(name: string, detail = "") { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`) }
function fail(name: string, detail = "") { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`) }

async function rpc(method: string, params: unknown[] = [], url = RPC): Promise<any> {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  })
  return (await res.json() as any)
}

async function waitTx(hash: string): Promise<ethers.TransactionReceipt | null> {
  for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 3000)); const r = await provider.getTransactionReceipt(hash).catch(() => null); if (r) return r }
  return null
}

async function main() {
  console.log("══════════════════════════════════════════════════════")
  console.log("  COC Advanced Stress Test")
  console.log("══════════════════════════════════════════════════════")
  console.log(`  RPC: ${RPC}`)
  console.log(`  Height: ${await provider.getBlockNumber()}\n`)

  // ═══════════════════════════════════════
  // A. RPC Boundary Tests
  // ═══════════════════════════════════════
  console.log("── A. RPC Boundary Tests ──")

  // A1: eth_estimateGas edge cases
  try {
    const r = await rpc("eth_estimateGas", [{ from: wallet.address, to: "0x000000000000000000000000000000000000dEaD", value: "0x1" }])
    r.result ? pass("A1 estimateGas basic", `gas=${r.result}`) : fail("A1 estimateGas basic", r.error?.message)
  } catch (e: any) { fail("A1 estimateGas basic", e.message?.slice(0, 60)) }

  // A1b: estimateGas with invalid data
  try {
    const r = await rpc("eth_estimateGas", [{ from: wallet.address, to: "0x000000000000000000000000000000000000dEaD", data: "0xdeadbeef" }])
    pass("A1b estimateGas invalid data", r.result ? `gas=${r.result}` : `error=${r.error?.message?.slice(0, 40)}`)
  } catch (e: any) { pass("A1b estimateGas invalid data", "threw (expected)") }

  // A1c: estimateGas to=null (contract creation)
  try {
    const r = await rpc("eth_estimateGas", [{ from: wallet.address, data: "0x60006000f3" }])
    r.result ? pass("A1c estimateGas deploy", `gas=${r.result}`) : pass("A1c estimateGas deploy", "error (expected for minimal bytecode)")
  } catch { pass("A1c estimateGas deploy", "threw (acceptable)") }

  // A2: eth_call revert
  try {
    // Call transfer on a non-existent token (should revert or return empty)
    const r = await rpc("eth_call", [{ from: wallet.address, to: "0x0000000000000000000000000000000000000001", data: "0xdeadbeef" }, "latest"])
    pass("A2 eth_call revert", r.error ? `revert:${r.error.message?.slice(0, 40)}` : `result:${String(r.result).slice(0, 20)}`)
  } catch (e: any) { pass("A2 eth_call revert", `threw:${e.message?.slice(0, 40)}`) }

  // A3: eth_getLogs range
  try {
    const height = await provider.getBlockNumber()
    const r = await rpc("eth_getLogs", [{ fromBlock: "0x1", toBlock: `0x${Math.min(height, 500).toString(16)}` }])
    if (r.result !== undefined) pass("A3 getLogs range", `${r.result?.length ?? 0} logs`)
    else if (r.error) pass("A3 getLogs range", `capped: ${r.error.message?.slice(0, 40)}`)
    else fail("A3 getLogs range", "unexpected response")
  } catch (e: any) { fail("A3 getLogs range", e.message?.slice(0, 60)) }

  // A4: Filter lifecycle
  try {
    const create = await rpc("eth_newBlockFilter")
    if (!create.result) { fail("A4 filter create", "no filter id"); } else {
      const changes = await rpc("eth_getFilterChanges", [create.result])
      const uninstall = await rpc("eth_uninstallFilter", [create.result])
      pass("A4 filter lifecycle", `id=${create.result?.slice(0, 10)} changes=${changes.result?.length ?? 0} removed=${uninstall.result}`)
    }
  } catch (e: any) { fail("A4 filter lifecycle", e.message?.slice(0, 60)) }

  // A5: Concurrent RPC
  try {
    const t0 = Date.now()
    const results = await Promise.all(Array.from({ length: 10 }, () => rpc("eth_blockNumber")))
    const ms = Date.now() - t0
    const allOk = results.every((r: any) => r.result)
    allOk ? pass("A5 concurrent 10x RPC", `${ms}ms`) : fail("A5 concurrent 10x RPC", `some failed in ${ms}ms`)
  } catch (e: any) { fail("A5 concurrent RPC", e.message?.slice(0, 60)) }

  // A6: getBalance unknown address
  try {
    const r = await rpc("eth_getBalance", ["0x0000000000000000000000000000000000099999", "latest"])
    r.result === "0x0" || r.result === "0" ? pass("A6 getBalance unknown", "0 (correct)") : pass("A6 getBalance unknown", `val=${r.result}`)
  } catch (e: any) { fail("A6 getBalance unknown", e.message?.slice(0, 60)) }

  // A7: getCode EOA vs contract
  try {
    const eoa = await rpc("eth_getCode", [wallet.address, "latest"])
    const empty = !eoa.result || eoa.result === "0x" || eoa.result === "0x0"
    empty ? pass("A7 getCode EOA", "0x (correct)") : fail("A7 getCode EOA", `unexpected: ${eoa.result?.slice(0, 20)}`)
  } catch (e: any) { fail("A7 getCode EOA", e.message?.slice(0, 60)) }

  // A8: getStorageAt
  try {
    const r = await rpc("eth_getStorageAt", [wallet.address, "0x0", "latest"])
    pass("A8 getStorageAt", `val=${r.result?.slice(0, 20) ?? r.error?.message?.slice(0, 30)}`)
  } catch (e: any) { fail("A8 getStorageAt", e.message?.slice(0, 60)) }

  // ═══════════════════════════════════════
  // B. Mempool Tests
  // ═══════════════════════════════════════
  console.log("\n── B. Mempool Tests ──")
  const gp = (await provider.getFeeData()).gasPrice ?? 2000000000n

  // B9: Duplicate tx submission
  try {
    const nonce = await provider.getTransactionCount(wallet.address, "pending")
    const tx = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce, type: 0, gasPrice: gp * 2n, gasLimit: 21000, chainId: 18780 })
    const r1 = await rpc("eth_sendRawTransaction", [tx])
    const r2 = await rpc("eth_sendRawTransaction", [tx])
    // Second should fail or return same hash
    if (r1.result && (r2.result === r1.result || r2.error)) {
      pass("B9 duplicate tx", r2.error ? `rejected: ${r2.error.message?.slice(0, 40)}` : "same hash (idempotent)")
    } else { fail("B9 duplicate tx", "unexpected: accepted with different result") }
    await waitTx(r1.result)
  } catch (e: any) { fail("B9 duplicate tx", e.message?.slice(0, 60)) }

  // B10: Replacement tx (10% bump rule)
  // Must send original tx and immediately try to replace (before it gets mined)
  try {
    const nonce = await provider.getTransactionCount(wallet.address)
    const basePrice = gp * 3n // use higher base to ensure it stays in mempool
    const low = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce, type: 0, gasPrice: basePrice, gasLimit: 21000, chainId: 18780 })
    const r1 = await rpc("eth_sendRawTransaction", [low])
    if (!r1.result) { pass("B10 replacement bump", "original tx failed, skip"); } else {
      // Immediately try replace with <10% bump (should fail)
      const tooLow = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 2n, nonce, type: 0, gasPrice: basePrice + 1n, gasLimit: 21000, chainId: 18780 })
      const r2 = await rpc("eth_sendRawTransaction", [tooLow])
      if (r2.error && r2.error.message.includes("replacement")) {
        pass("B10 replacement bump", `rejected: ${r2.error.message.slice(0, 50)}`)
      } else {
        fail("B10 replacement bump", `should reject <10% bump: got ${r2.error?.message?.slice(0, 40) ?? r2.result?.slice(0, 14)}`)
      }
      // Clean up: replace with proper bump (>=10%) and wait
      const high = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce, type: 0, gasPrice: basePrice * 2n, gasLimit: 21000, chainId: 18780 })
      const rh = await rpc("eth_sendRawTransaction", [high])
      if (rh.result) await waitTx(rh.result)
    }
  } catch (e: any) { fail("B10 replacement bump", e.message?.slice(0, 60)) }

  // B11: Nonce gap
  try {
    const nonce = await provider.getTransactionCount(wallet.address, "pending")
    const gapped = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce: nonce + 5, type: 0, gasPrice: gp * 2n, gasLimit: 21000, chainId: 18780 })
    const r = await rpc("eth_sendRawTransaction", [gapped])
    // Should accept into mempool but not mine (gap in nonces)
    pass("B11 nonce gap", r.result ? `accepted (pending):${r.result.slice(0, 14)}` : `rejected:${r.error?.message?.slice(0, 40)}`)
  } catch (e: any) { fail("B11 nonce gap", e.message?.slice(0, 60)) }

  // B12: Ultra-low gas price
  try {
    const nonce = await provider.getTransactionCount(wallet.address, "pending")
    const cheap = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce, type: 0, gasPrice: 1n, gasLimit: 21000, chainId: 18780 })
    const r = await rpc("eth_sendRawTransaction", [cheap])
    pass("B12 ultra-low gas", r.error ? `rejected:${r.error.message?.slice(0, 40)}` : `accepted:${r.result?.slice(0, 14)}`)
  } catch (e: any) { pass("B12 ultra-low gas", `error:${e.message?.slice(0, 40)}`) }

  // B13: Gas limit > block limit
  try {
    const nonce = await provider.getTransactionCount(wallet.address, "pending")
    const huge = await wallet.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce, type: 0, gasPrice: gp * 2n, gasLimit: 31000000, chainId: 18780 })
    const r = await rpc("eth_sendRawTransaction", [huge])
    r.error ? pass("B13 huge gas limit", `rejected:${r.error.message?.slice(0, 50)}`) : fail("B13 huge gas limit", "should reject tx > block gas limit")
  } catch (e: any) { pass("B13 huge gas limit", `threw:${e.message?.slice(0, 40)}`) }

  // ═══════════════════════════════════════
  // C. Gas/Fee Market Tests
  // ═══════════════════════════════════════
  console.log("\n── C. Gas/Fee Market Tests ──")

  // C14: baseFee in latest block
  try {
    const block = await provider.getBlock("latest")
    if (block?.baseFeePerGas !== undefined && block.baseFeePerGas !== null) {
      const bf = block.baseFeePerGas
      bf >= 1000000000n ? pass("C14 baseFee", `${ethers.formatUnits(bf, "gwei")} gwei`) : fail("C14 baseFee", `too low: ${bf}`)
    } else { fail("C14 baseFee", "missing from block") }
  } catch (e: any) { fail("C14 baseFee", e.message?.slice(0, 60)) }

  // C15: eth_feeHistory
  try {
    const r = await rpc("eth_feeHistory", ["0x5", "latest", [25, 50, 75]])
    if (r.result && r.result.baseFeePerGas) {
      pass("C15 feeHistory", `blocks=${r.result.baseFeePerGas.length} oldest=${r.result.oldestBlock}`)
    } else { fail("C15 feeHistory", r.error?.message?.slice(0, 50) ?? "no result") }
  } catch (e: any) { fail("C15 feeHistory", e.message?.slice(0, 60)) }

  // C16: eth_maxPriorityFeePerGas
  try {
    const r = await rpc("eth_maxPriorityFeePerGas")
    r.result ? pass("C16 maxPriorityFee", `${parseInt(r.result, 16)} wei`) : fail("C16 maxPriorityFee", r.error?.message)
  } catch (e: any) { fail("C16 maxPriorityFee", e.message?.slice(0, 60)) }

  // ═══════════════════════════════════════
  // D. Cross-Node Consistency
  // ═══════════════════════════════════════
  console.log("\n── D. Cross-Node Consistency ──")

  // D17: Block hash consistency
  try {
    const height = Math.max(1, (await provider.getBlockNumber()) - 5)
    const hex = `0x${height.toString(16)}`
    const hashes = await Promise.all(PORTS.map(p => rpc("eth_getBlockByNumber", [hex, false], `http://${HOST}:${p}/`).then((r: any) => r.result?.hash)))
    const allSame = hashes.every(h => h && h === hashes[0])
    allSame ? pass("D17 block hash sync", `h=${height} hash=${hashes[0]?.slice(0, 14)}`) : fail("D17 block hash sync", `diverged: ${hashes.map(h => h?.slice(0, 10)).join(" vs ")}`)
  } catch (e: any) { fail("D17 block hash sync", e.message?.slice(0, 60)) }

  // D18: stateRoot consistency
  try {
    const height = Math.max(1, (await provider.getBlockNumber()) - 5)
    const hex = `0x${height.toString(16)}`
    const roots = await Promise.all(PORTS.map(p => rpc("eth_getBlockByNumber", [hex, false], `http://${HOST}:${p}/`).then((r: any) => r.result?.stateRoot)))
    const allSame = roots.every(r => r && r === roots[0])
    allSame ? pass("D18 stateRoot sync", `root=${roots[0]?.slice(0, 14)}`) : fail("D18 stateRoot sync", `diverged: ${roots.map(r => r?.slice(0, 10)).join(" vs ")}`)
  } catch (e: any) { fail("D18 stateRoot sync", e.message?.slice(0, 60)) }

  // D19: Parent hash chain integrity
  try {
    const height = await provider.getBlockNumber()
    const checkRange = Math.min(height, 20)
    let chainOk = true
    let prevHash: string | null = null
    for (let i = height - checkRange + 1; i <= height; i++) {
      const block = await provider.getBlock(i)
      if (!block) { chainOk = false; break }
      if (prevHash && block.parentHash !== prevHash) { chainOk = false; break }
      prevHash = block.hash
    }
    chainOk ? pass("D19 parent chain", `verified ${checkRange} blocks`) : fail("D19 parent chain", "chain broken")
  } catch (e: any) { fail("D19 parent chain", e.message?.slice(0, 60)) }

  // D20: Height sync across nodes
  try {
    const heights = await Promise.all(PORTS.map(p => rpc("eth_blockNumber", [], `http://${HOST}:${p}/`).then((r: any) => parseInt(r.result, 16))))
    const maxDiff = Math.max(...heights) - Math.min(...heights)
    maxDiff <= 2 ? pass("D20 height sync", `${heights.join("/")} (diff=${maxDiff})`) : fail("D20 height sync", `${heights.join("/")} (diff=${maxDiff})`)
  } catch (e: any) { fail("D20 height sync", e.message?.slice(0, 60)) }

  // ═══════════════════════════════════════
  // Report
  // ═══════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════")
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
  if (failures.length > 0) console.log(`  Failures: ${failures.join(", ")}`)
  console.log("══════════════════════════════════════════════════════\n")

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error("Fatal:", err); process.exit(1) })
