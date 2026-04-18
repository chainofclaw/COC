/**
 * COC Testnet EVM Limits Test
 *
 * Tests EVM computation and storage boundaries on the live 3-node BFT testnet.
 * - Computation limits via eth_call (no transactions, no stall risk)
 * - Storage limits via sequential single transactions
 *
 * Usage: node --experimental-strip-types scripts/evm-limits.ts [rpc_url]
 */
import { ethers } from "ethers"
import { readFileSync } from "node:fs"

const RPC = process.argv[2] || "http://199.192.16.79:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(DEPLOYER_KEY, provider)

interface TestResult {
  test: string
  param: string
  gas: string
  timeMs: number
  status: "OK" | "OOG" | "FAIL" | "TIMEOUT"
}

const RESULTS: TestResult[] = []

function report(r: TestResult) {
  RESULTS.push(r)
  const icon = r.status === "OK" ? "✅" : r.status === "OOG" ? "⛽" : "❌"
  console.log(`  ${icon} ${r.test.padEnd(22)} ${r.param.padEnd(12)} gas=${r.gas.padEnd(12)} ${r.timeMs}ms`)
}

async function waitTx(hash: string): Promise<ethers.TransactionReceipt | null> {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const r = await provider.getTransactionReceipt(hash).catch(() => null)
    if (r) return r
  }
  return null
}

async function main() {
  console.log("══════════════════════════════════════════════════════")
  console.log("  COC Testnet — EVM Computation & Storage Limits")
  console.log("══════════════════════════════════════════════════════")
  console.log(`  RPC: ${RPC}`)
  console.log(`  Height: ${await provider.getBlockNumber()}`)
  console.log(`  Block Gas Limit: 30,000,000\n`)

  // ── Deploy HeavyCompute ──
  console.log("── Deploying HeavyCompute contract ──")
  const artifact = JSON.parse(readFileSync(
    new URL("../contracts/artifacts/contracts-src/test-contracts/HeavyCompute.sol/HeavyCompute.json", import.meta.url), "utf-8"
  ))
  const fee = await provider.getFeeData()
  const gp = (fee.gasPrice ?? 2000000000n) * 2n

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet)
  const contract = await factory.deploy({ type: 0, gasPrice: gp, gasLimit: 500000 })
  const deployReceipt = await waitTx(contract.deploymentTransaction()!.hash)
  if (!deployReceipt || deployReceipt.status !== 1) {
    console.log("  DEPLOY FAILED — aborting")
    return
  }
  const addr = deployReceipt.contractAddress!
  const heavy = new ethers.Contract(addr, artifact.abi, wallet)
  console.log(`  Deployed at ${addr} (gas: ${deployReceipt.gasUsed})\n`)

  // ── Computation Limits (eth_call, no tx needed) ──
  console.log("── Computation Limits (eth_call) ──")

  // Fibonacci
  for (const n of [50, 100, 500, 1000, 5000, 10000, 50000]) {
    const t0 = Date.now()
    try {
      const result = await heavy.fibonacci(n)
      const gas = await heavy.fibonacci.estimateGas(n).catch(() => "est_fail")
      report({ test: "fibonacci", param: `n=${n}`, gas: String(gas), timeMs: Date.now() - t0, status: "OK" })
    } catch (e: any) {
      const isOOG = String(e).includes("gas") || String(e).includes("revert")
      report({ test: "fibonacci", param: `n=${n}`, gas: "N/A", timeMs: Date.now() - t0, status: isOOG ? "OOG" : "FAIL" })
      if (isOOG) break
    }
  }

  // Sort array
  for (const n of [50, 100, 200, 500, 1000]) {
    const arr = Array.from({ length: n }, (_, i) => n - i) // reverse sorted
    const t0 = Date.now()
    try {
      await heavy.sortArray(arr)
      const gas = await heavy.sortArray.estimateGas(arr).catch(() => "est_fail")
      report({ test: "sortArray", param: `n=${n}`, gas: String(gas), timeMs: Date.now() - t0, status: "OK" })
    } catch (e: any) {
      report({ test: "sortArray", param: `n=${n}`, gas: "N/A", timeMs: Date.now() - t0, status: String(e).includes("gas") ? "OOG" : "FAIL" })
      if (String(e).includes("gas")) break
    }
  }

  // Hash loop
  for (const n of [1000, 5000, 10000, 50000, 100000, 500000]) {
    const t0 = Date.now()
    try {
      const gas = await heavy.hashLoop.estimateGas(n)
      report({ test: "hashLoop", param: `n=${n}`, gas: String(gas), timeMs: Date.now() - t0, status: "OK" })
    } catch (e: any) {
      report({ test: "hashLoop", param: `n=${n}`, gas: "N/A", timeMs: Date.now() - t0, status: "OOG" })
      break
    }
  }

  // Memory expand
  for (const kb of [32, 64, 128, 256, 512, 1024, 2048]) {
    const sizeBytes = kb * 1024
    const t0 = Date.now()
    try {
      await heavy.memoryExpand(sizeBytes)
      const gas = await heavy.memoryExpand.estimateGas(sizeBytes).catch(() => "est_fail")
      report({ test: "memoryExpand", param: `${kb}KB`, gas: String(gas), timeMs: Date.now() - t0, status: "OK" })
    } catch (e: any) {
      report({ test: "memoryExpand", param: `${kb}KB`, gas: "N/A", timeMs: Date.now() - t0, status: "OOG" })
      break
    }
  }

  // ── Storage Limits (sequential single tx) ──
  console.log("\n── Storage Limits (on-chain transactions) ──")

  for (const n of [100, 200, 500, 1000, 1500]) {
    const t0 = Date.now()
    try {
      const gasEst = await heavy.batchWrite.estimateGas(n)
      if (gasEst > 29_000_000n) {
        report({ test: "batchWrite", param: `n=${n}`, gas: String(gasEst) + " (est)", timeMs: Date.now() - t0, status: "OOG" })
        break
      }
      const tx = await heavy.batchWrite(n, { type: 0, gasPrice: gp, gasLimit: gasEst * 12n / 10n })
      const receipt = await waitTx(tx.hash)
      if (receipt) {
        report({ test: "batchWrite", param: `n=${n}`, gas: String(receipt.gasUsed), timeMs: Date.now() - t0, status: receipt.status === 1 ? "OK" : "FAIL" })
      } else {
        report({ test: "batchWrite", param: `n=${n}`, gas: "N/A", timeMs: Date.now() - t0, status: "TIMEOUT" })
        break
      }
    } catch (e: any) {
      report({ test: "batchWrite", param: `n=${n}`, gas: "N/A", timeMs: Date.now() - t0, status: "OOG" })
      break
    }
  }

  // Batch read (view call — no tx)
  for (const n of [100, 500, 1000, 2000, 5000]) {
    const t0 = Date.now()
    try {
      const sum = await heavy.batchRead(n)
      const gas = await heavy.batchRead.estimateGas(n).catch(() => "est_fail")
      report({ test: "batchRead", param: `n=${n}`, gas: String(gas), timeMs: Date.now() - t0, status: "OK" })
    } catch {
      report({ test: "batchRead", param: `n=${n}`, gas: "N/A", timeMs: Date.now() - t0, status: "OOG" })
      break
    }
  }

  // Combined stress (tx)
  for (const [w, h] of [[100, 1000], [200, 2000], [500, 5000]] as const) {
    const t0 = Date.now()
    try {
      const gasEst = await heavy.combinedStress.estimateGas(w, h)
      if (gasEst > 29_000_000n) {
        report({ test: "combinedStress", param: `w=${w},h=${h}`, gas: String(gasEst) + " (est)", timeMs: Date.now() - t0, status: "OOG" })
        break
      }
      const tx = await heavy.combinedStress(w, h, { type: 0, gasPrice: gp, gasLimit: gasEst * 12n / 10n })
      const receipt = await waitTx(tx.hash)
      if (receipt) {
        report({ test: "combinedStress", param: `w=${w},h=${h}`, gas: String(receipt.gasUsed), timeMs: Date.now() - t0, status: receipt.status === 1 ? "OK" : "FAIL" })
      } else {
        report({ test: "combinedStress", param: `w=${w},h=${h}`, gas: "N/A", timeMs: Date.now() - t0, status: "TIMEOUT" })
        break
      }
    } catch {
      report({ test: "combinedStress", param: `w=${w},h=${h}`, gas: "N/A", timeMs: Date.now() - t0, status: "OOG" })
      break
    }
  }

  // ── Node sync check ──
  console.log("\n── Post-test node sync ──")
  for (const port of [28780, 28782, 28784]) {
    const p = new ethers.JsonRpcProvider(`http://199.192.16.79:${port}`)
    console.log(`  node(${port}): h=${await p.getBlockNumber()}`)
  }

  // ── Final Report ──
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  EVM Limits Report — COC Testnet (chainId 18780)")
  console.log("══════════════════════════════════════════════════════")
  console.log("  " + "Test".padEnd(22) + "Param".padEnd(14) + "Gas".padEnd(16) + "Time(ms)".padEnd(10) + "Status")
  console.log("  " + "─".repeat(68))
  for (const r of RESULTS) {
    console.log("  " + r.test.padEnd(22) + r.param.padEnd(14) + r.gas.padEnd(16) + String(r.timeMs).padEnd(10) + r.status)
  }

  // Summary
  const okCount = RESULTS.filter(r => r.status === "OK").length
  const oogCount = RESULTS.filter(r => r.status === "OOG").length
  console.log(`\n  Summary: ${okCount} OK, ${oogCount} OOG (out of gas), ${RESULTS.length} total`)
  console.log("══════════════════════════════════════════════════════\n")
}

main().catch(err => { console.error("Fatal:", err); process.exit(1) })
