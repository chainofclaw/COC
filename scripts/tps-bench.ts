/**
 * TPS Benchmark Script
 *
 * Sends signed transactions to a running COC node to measure throughput.
 *
 * Usage:
 *   node --experimental-strip-types scripts/tps-bench.ts [options]
 *
 * Options:
 *   --rpc <url>       RPC endpoint (default: http://127.0.0.1:18780)
 *   --tps <number>    Target transactions per second (default: 50)
 *   --duration <sec>  Test duration in seconds (default: 30)
 *   --senders <n>     Number of concurrent sender wallets (default: 5)
 *   --key <hex>       Funded private key (default: Hardhat key #0)
 */

import { Wallet, Transaction, JsonRpcProvider, parseEther } from "ethers"

const CHAIN_ID = 18780
const DEFAULT_RPC = "http://127.0.0.1:18780"
const DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

interface BenchConfig {
  rpcUrl: string
  targetTps: number
  durationSec: number
  senderCount: number
  fundingKey: string
}

function parseArgs(): BenchConfig {
  const args = process.argv.slice(2)
  const config: BenchConfig = {
    rpcUrl: DEFAULT_RPC,
    targetTps: 50,
    durationSec: 30,
    senderCount: 5,
    fundingKey: DEFAULT_KEY,
  }
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const val = args[i + 1]
    if (flag === "--rpc") config.rpcUrl = val
    else if (flag === "--tps") config.targetTps = parseInt(val, 10)
    else if (flag === "--duration") config.durationSec = parseInt(val, 10)
    else if (flag === "--senders") config.senderCount = parseInt(val, 10)
    else if (flag === "--key") config.fundingKey = val
  }
  return config
}

async function rpcCall(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  })
  const json = (await resp.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

async function getBlockHeight(url: string): Promise<number> {
  const hex = (await rpcCall(url, "eth_blockNumber")) as string
  return parseInt(hex, 16)
}

async function getNonce(url: string, address: string): Promise<number> {
  const hex = (await rpcCall(url, "eth_getTransactionCount", [address, "pending"])) as string
  return parseInt(hex, 16)
}

function signTx(wallet: Wallet, nonce: number, to: string, value: bigint): string {
  const tx = Transaction.from({
    to,
    value: `0x${value.toString(16)}`,
    nonce,
    gasLimit: "0x5208",
    gasPrice: "0x3b9aca00",
    chainId: CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized
}

async function fundSenders(
  config: BenchConfig,
  fundingWallet: Wallet,
  senders: Wallet[],
): Promise<void> {
  const fundAmount = parseEther("100")
  let nonce = await getNonce(config.rpcUrl, fundingWallet.address)

  console.log(`Funding ${senders.length} sender wallets...`)
  for (const sender of senders) {
    const rawTx = signTx(fundingWallet, nonce++, sender.address, fundAmount)
    await rpcCall(config.rpcUrl, "eth_sendRawTransaction", [rawTx])
  }

  // Wait for funding txs to be mined
  await new Promise((r) => setTimeout(r, 3000))
  console.log("Funding complete.")
}

interface BenchResult {
  totalSent: number
  totalConfirmed: number
  durationMs: number
  actualTps: number
  avgLatencyMs: number
  p95LatencyMs: number
  startHeight: number
  endHeight: number
  blocksProduced: number
}

async function runBenchmark(config: BenchConfig, senders: Wallet[]): Promise<BenchResult> {
  const target = "0x000000000000000000000000000000000000dEaD"
  const intervalMs = 1000 / config.targetTps
  const totalTxs = config.targetTps * config.durationSec
  const txPerSender = Math.ceil(totalTxs / senders.length)

  // Get starting nonces
  const nonces = await Promise.all(
    senders.map((s) => getNonce(config.rpcUrl, s.address)),
  )

  const startHeight = await getBlockHeight(config.rpcUrl)
  const latencies: number[] = []
  let sent = 0
  let errors = 0
  const senderIdx = { current: 0 }

  console.log(`\nBenchmark: ${config.targetTps} TPS for ${config.durationSec}s (${totalTxs} total txs)`)
  console.log(`Senders: ${senders.length}, Interval: ${intervalMs.toFixed(1)}ms\n`)

  const startTime = performance.now()

  // Send transactions at target rate
  await new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      if (sent >= totalTxs) {
        clearInterval(timer)
        resolve()
        return
      }

      const idx = senderIdx.current % senders.length
      senderIdx.current++
      const wallet = senders[idx]
      const nonce = nonces[idx]++

      const txStart = performance.now()
      try {
        const rawTx = signTx(wallet, nonce, target, 1n)
        await rpcCall(config.rpcUrl, "eth_sendRawTransaction", [rawTx])
        latencies.push(performance.now() - txStart)
      } catch {
        errors++
      }
      sent++

      // Progress every 10%
      if (sent % Math.max(1, Math.floor(totalTxs / 10)) === 0) {
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
        const currentTps = (sent / ((performance.now() - startTime) / 1000)).toFixed(1)
        process.stdout.write(`  [${elapsed}s] ${sent}/${totalTxs} txs sent (${currentTps} TPS, ${errors} errors)\r`)
      }
    }, intervalMs)
  })

  const durationMs = performance.now() - startTime
  console.log("")

  // Wait for remaining txs to be mined
  console.log("Waiting for blocks to finalize...")
  await new Promise((r) => setTimeout(r, 5000))

  const endHeight = await getBlockHeight(config.rpcUrl)

  // Calculate latency stats
  latencies.sort((a, b) => a - b)
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0
  const p95Index = Math.floor(latencies.length * 0.95)
  const p95Latency = latencies[p95Index] ?? 0

  return {
    totalSent: sent,
    totalConfirmed: sent - errors,
    durationMs,
    actualTps: ((sent - errors) / durationMs) * 1000,
    avgLatencyMs: avgLatency,
    p95LatencyMs: p95Latency,
    startHeight,
    endHeight,
    blocksProduced: endHeight - startHeight,
  }
}

function printReport(config: BenchConfig, result: BenchResult): void {
  console.log("\n" + "=".repeat(50))
  console.log("  TPS Benchmark Report")
  console.log("=".repeat(50))
  console.log(`  RPC Endpoint:    ${config.rpcUrl}`)
  console.log(`  Target TPS:      ${config.targetTps}`)
  console.log(`  Duration:        ${(result.durationMs / 1000).toFixed(1)}s`)
  console.log(`  Senders:         ${config.senderCount}`)
  console.log("")
  console.log(`  Txs Sent:        ${result.totalSent}`)
  console.log(`  Txs Confirmed:   ${result.totalConfirmed}`)
  console.log(`  Actual TPS:      ${result.actualTps.toFixed(1)}`)
  console.log(`  Avg Latency:     ${result.avgLatencyMs.toFixed(1)}ms`)
  console.log(`  P95 Latency:     ${result.p95LatencyMs.toFixed(1)}ms`)
  console.log("")
  console.log(`  Start Height:    ${result.startHeight}`)
  console.log(`  End Height:      ${result.endHeight}`)
  console.log(`  Blocks Produced: ${result.blocksProduced}`)
  console.log(`  Avg Txs/Block:   ${result.blocksProduced > 0 ? (result.totalConfirmed / result.blocksProduced).toFixed(1) : "N/A"}`)
  console.log("=".repeat(50))
}

async function main(): Promise<void> {
  const config = parseArgs()

  // Verify node connectivity
  try {
    const height = await getBlockHeight(config.rpcUrl)
    console.log(`Connected to ${config.rpcUrl} (block height: ${height})`)
  } catch (err) {
    console.error(`Cannot connect to ${config.rpcUrl}: ${err}`)
    process.exit(1)
  }

  // Create sender wallets
  const fundingWallet = new Wallet(config.fundingKey)
  const senders = Array.from({ length: config.senderCount }, () => Wallet.createRandom())

  // Fund senders
  await fundSenders(config, fundingWallet, senders)

  // Run benchmark
  const result = await runBenchmark(config, senders)

  // Print report
  printReport(config, result)
}

main().catch((err) => {
  console.error("Benchmark failed:", err)
  process.exit(1)
})
