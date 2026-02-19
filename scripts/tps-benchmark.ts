/**
 * TPS Benchmark Script
 *
 * Measures transaction throughput against a live COC node.
 * Supports sustained load, burst mode, and contract interaction benchmarks.
 *
 * Usage:
 *   node --experimental-strip-types scripts/tps-benchmark.ts [options]
 *
 * Options:
 *   --rpc <url>        RPC endpoint (default: http://127.0.0.1:18780)
 *   --mode <mode>       sustained | burst | contract (default: sustained)
 *   --duration <sec>    Test duration in seconds (default: 30)
 *   --rate <tps>        Target TPS for sustained mode (default: 50)
 *   --batch <n>         Batch size for burst mode (default: 100)
 *
 * Refs: #23
 */

import { Wallet, Transaction, JsonRpcProvider } from "ethers"

const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CHAIN_ID = 20241224
const SIMPLE_BYTECODE = "0x604260005260206000f3" // PUSH1 0x42 MSTORE RETURN

interface BenchmarkResult {
  mode: string
  totalTxSent: number
  totalTxConfirmed: number
  durationMs: number
  actualTps: number
  avgLatencyMs: number
  p95LatencyMs: number
  errors: number
}

function parseArgs(): {
  rpc: string
  mode: string
  duration: number
  rate: number
  batch: number
} {
  const args = process.argv.slice(2)
  const opts = { rpc: "http://127.0.0.1:18780", mode: "sustained", duration: 30, rate: 50, batch: 100 }

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace("--", "")
    const val = args[i + 1]
    if (!key || !val) continue
    if (key === "rpc") opts.rpc = val
    else if (key === "mode") opts.mode = val
    else if (key === "duration") opts.duration = parseInt(val, 10)
    else if (key === "rate") opts.rate = parseInt(val, 10)
    else if (key === "batch") opts.batch = parseInt(val, 10)
  }
  return opts
}

function signTx(wallet: Wallet, nonce: number, to: string, value: bigint, chainId: number, gasLimit = 21000n): string {
  const tx = Transaction.from({
    to,
    value: `0x${value.toString(16)}`,
    nonce,
    gasLimit: `0x${gasLimit.toString(16)}`,
    gasPrice: "0x3b9aca00",
    chainId,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized
}

function signDeployTx(wallet: Wallet, nonce: number, bytecode: string, chainId: number): string {
  const tx = Transaction.from({
    nonce,
    gasLimit: "0x100000",
    gasPrice: "0x3b9aca00",
    chainId,
    data: bytecode,
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized
}

async function sendRawTx(rpcUrl: string, rawTx: string): Promise<{ hash: string; latencyMs: number }> {
  const start = performance.now()
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [rawTx], id: 1 }),
  })
  const json = (await res.json()) as { result?: string; error?: { message: string } }
  const latencyMs = performance.now() - start

  if (json.error) throw new Error(json.error.message)
  return { hash: json.result ?? "", latencyMs }
}

async function getChainId(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
  })
  const json = (await res.json()) as { result: string }
  return parseInt(json.result, 16)
}

async function getNonce(rpcUrl: string, address: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [address, "pending"], id: 1 }),
  })
  const json = (await res.json()) as { result: string }
  return parseInt(json.result, 16)
}

async function getBlockNumber(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
  })
  const json = (await res.json()) as { result: string }
  return parseInt(json.result, 16)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

async function sustainedBenchmark(rpcUrl: string, chainId: number, durationSec: number, targetTps: number): Promise<BenchmarkResult> {
  const wallet = new Wallet(FUNDED_PK)
  const target = "0x000000000000000000000000000000000000dEaD"
  let nonce = await getNonce(rpcUrl, wallet.address)

  const latencies: number[] = []
  let errors = 0
  const intervalMs = 1000 / targetTps
  const startTime = performance.now()
  const endTime = startTime + durationSec * 1000

  console.log(`  Sustained load: ${targetTps} TPS for ${durationSec}s`)

  while (performance.now() < endTime) {
    const batchStart = performance.now()
    const rawTx = signTx(wallet, nonce++, target, 1n, chainId)

    try {
      const { latencyMs } = await sendRawTx(rpcUrl, rawTx)
      latencies.push(latencyMs)
    } catch {
      errors++
    }

    const elapsed = performance.now() - batchStart
    if (elapsed < intervalMs) {
      await new Promise((r) => setTimeout(r, intervalMs - elapsed))
    }
  }

  const totalDuration = performance.now() - startTime
  const sorted = [...latencies].sort((a, b) => a - b)

  return {
    mode: "sustained",
    totalTxSent: latencies.length + errors,
    totalTxConfirmed: latencies.length,
    durationMs: totalDuration,
    actualTps: (latencies.length / totalDuration) * 1000,
    avgLatencyMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    p95LatencyMs: percentile(sorted, 95),
    errors,
  }
}

async function burstBenchmark(rpcUrl: string, chainId: number, batchSize: number): Promise<BenchmarkResult> {
  const wallet = new Wallet(FUNDED_PK)
  const target = "0x000000000000000000000000000000000000dEaD"
  let nonce = await getNonce(rpcUrl, wallet.address)

  console.log(`  Burst load: ${batchSize} transactions`)

  // Pre-sign all transactions
  const rawTxs = Array.from({ length: batchSize }, (_, i) => signTx(wallet, nonce + i, target, 1n, chainId))

  const latencies: number[] = []
  let errors = 0
  const startTime = performance.now()

  // Send all in parallel
  const results = await Promise.allSettled(rawTxs.map((rawTx) => sendRawTx(rpcUrl, rawTx)))

  for (const result of results) {
    if (result.status === "fulfilled") {
      latencies.push(result.value.latencyMs)
    } else {
      errors++
    }
  }

  const totalDuration = performance.now() - startTime
  const sorted = [...latencies].sort((a, b) => a - b)

  return {
    mode: "burst",
    totalTxSent: batchSize,
    totalTxConfirmed: latencies.length,
    durationMs: totalDuration,
    actualTps: (latencies.length / totalDuration) * 1000,
    avgLatencyMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    p95LatencyMs: percentile(sorted, 95),
    errors,
  }
}

async function contractBenchmark(rpcUrl: string, chainId: number, count: number): Promise<BenchmarkResult> {
  const wallet = new Wallet(FUNDED_PK)
  let nonce = await getNonce(rpcUrl, wallet.address)

  console.log(`  Contract deployments: ${count} contracts`)

  const rawTxs = Array.from({ length: count }, (_, i) => signDeployTx(wallet, nonce + i, SIMPLE_BYTECODE, chainId))

  const latencies: number[] = []
  let errors = 0
  const startTime = performance.now()

  for (const rawTx of rawTxs) {
    try {
      const { latencyMs } = await sendRawTx(rpcUrl, rawTx)
      latencies.push(latencyMs)
    } catch {
      errors++
    }
  }

  const totalDuration = performance.now() - startTime
  const sorted = [...latencies].sort((a, b) => a - b)

  return {
    mode: "contract",
    totalTxSent: count,
    totalTxConfirmed: latencies.length,
    durationMs: totalDuration,
    actualTps: (latencies.length / totalDuration) * 1000,
    avgLatencyMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    p95LatencyMs: percentile(sorted, 95),
    errors,
  }
}

function printResult(result: BenchmarkResult): void {
  console.log(`\n  ── ${result.mode.toUpperCase()} Results ──`)
  console.log(`  Tx Sent:      ${result.totalTxSent}`)
  console.log(`  Tx Confirmed: ${result.totalTxConfirmed}`)
  console.log(`  Duration:     ${(result.durationMs / 1000).toFixed(1)}s`)
  console.log(`  Actual TPS:   ${result.actualTps.toFixed(1)}`)
  console.log(`  Avg Latency:  ${result.avgLatencyMs.toFixed(1)}ms`)
  console.log(`  P95 Latency:  ${result.p95LatencyMs.toFixed(1)}ms`)
  console.log(`  Errors:       ${result.errors}`)
}

async function main(): Promise<void> {
  const opts = parseArgs()
  console.log(`\nTPS Benchmark — ${opts.rpc}`)
  console.log(`Mode: ${opts.mode}, Duration: ${opts.duration}s\n`)

  try {
    const chainId = await getChainId(opts.rpc)
    const startBlock = await getBlockNumber(opts.rpc)
    console.log(`  Chain ID: ${chainId}, Start Block: ${startBlock}`)

    let result: BenchmarkResult

    if (opts.mode === "burst") {
      result = await burstBenchmark(opts.rpc, chainId, opts.batch)
    } else if (opts.mode === "contract") {
      result = await contractBenchmark(opts.rpc, chainId, opts.batch)
    } else {
      result = await sustainedBenchmark(opts.rpc, chainId, opts.duration, opts.rate)
    }

    const endBlock = await getBlockNumber(opts.rpc)
    console.log(`  End Block: ${endBlock} (+${endBlock - startBlock} blocks)`)

    printResult(result)
  } catch (err) {
    console.error(`\n  Failed to connect to ${opts.rpc}:`, (err as Error).message)
    process.exit(1)
  }
}

main()
