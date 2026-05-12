#!/usr/bin/env node
// COC active stress probe.
//
// Fires N pre-signed txs in parallel from the probe wallet (single account,
// sequential nonces — mempool's per-sender lane) and measures throughput,
// per-tx inclusion latency, and block-distribution.
//
// Modes:
//   value    — 1-wei transfers to ZeroAddress (mempool + minimal EVM)
//   call     — increment() the persistent counter contract (SSTORE per tx)
//   mixed    — 50/50 value + call
//
// Pass criteria (defaults, override via env):
//   - 100% of submitted txs eventually included (status=1)
//   - p95 inclusion latency ≤ STRESS_P95_MS_LIMIT (30000 ms)
//   - observed TPS ≥ STRESS_TPS_MIN (5)
//
// Use sparingly. Each invocation pushes N txs to the public chain. Default
// N=50 + mode=value = ~1.1 GWei in gas. Run from health-loop every Nth tick,
// not every tick.
//
// Env knobs (in addition to active-probe's):
//   STRESS_N                default 50
//   STRESS_MODE             default 'value'  (value|call|mixed)
//   STRESS_GAS_PRICE_GWEI   default 2
//   STRESS_COUNTER_ADDR     optional reuse of an already-deployed counter
//   STRESS_TIMEOUT_MS       default 90000 (total deadline)
//   STRESS_P95_MS_LIMIT     default 30000
//   STRESS_TPS_MIN          default 5
//   STRESS_REPORT_JSON      optional path

import { ethers } from 'ethers'
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const cfg = {
  rpc: process.env.PROBE_RPC || 'https://clawchain.io/api/testnet/rpc',
  chainId: Number(process.env.PROBE_CHAIN_ID || '88780'),
  probePk: process.env.PROBE_PK || '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  n: Number(process.env.STRESS_N || '32'),
  // mempool per-sender cap is 64 on 88780 (see node/src/mempool.ts:181). Stay
  // well under it: 32 leaves headroom for retry + parallel callers. If a prior
  // run left a nonce gap in pending, refuse to fire.
  maxPerSenderCap: Number(process.env.STRESS_PER_SENDER_CAP || '60'),
  mode: process.env.STRESS_MODE || 'value',
  gasPriceGwei: Number(process.env.STRESS_GAS_PRICE_GWEI || '2'),
  counterAddr: process.env.STRESS_COUNTER_ADDR || null,
  totalTimeoutMs: Number(process.env.STRESS_TIMEOUT_MS || '90000'),
  p95LimitMs: Number(process.env.STRESS_P95_MS_LIMIT || '30000'),
  tpsMin: Number(process.env.STRESS_TPS_MIN || '5'),
  reportJson: process.env.STRESS_REPORT_JSON || null,
  counterStateFile: process.env.STRESS_COUNTER_STATE || '/var/lib/coc-synthetic/stress-counter.json',
}

const COUNTER_BYTECODE = '0x6000600055600a6011600039600a6000f360005460010160005500'

const provider = new ethers.JsonRpcProvider(
  cfg.rpc,
  { chainId: cfg.chainId, name: 'ChainOfClaw' },
  { staticNetwork: ethers.Network.from({ chainId: cfg.chainId, name: 'ChainOfClaw' }) },
)
const wallet = new ethers.Wallet(cfg.probePk, provider)

function pct(arr, p) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.floor(s.length * p / 100))
  return s[i]
}

// Persist a single counter contract addr across runs so we don't deploy
// a fresh contract every stress invocation.
async function ensureCounter() {
  if (cfg.counterAddr) return cfg.counterAddr
  let known = null
  if (existsSync(cfg.counterStateFile)) {
    try { known = JSON.parse(readFileSync(cfg.counterStateFile, 'utf8')).addr } catch {}
  }
  if (known) {
    const code = await provider.getCode(known)
    if (code !== '0x') return known
  }
  console.log('[stress] deploying counter contract ...')
  const tx = await wallet.sendTransaction({ data: COUNTER_BYTECODE })
  const r = await tx.wait()
  if (r.status !== 1 || !r.contractAddress) throw new Error('counter deploy failed')
  const dir = dirname(cfg.counterStateFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(cfg.counterStateFile, JSON.stringify({ addr: r.contractAddress, deployedAt: new Date().toISOString() }, null, 2))
  console.log(`[stress] counter at ${r.contractAddress} (block ${r.blockNumber})`)
  return r.contractAddress
}

async function runStress() {
  const startedAt = new Date().toISOString()
  const counterAddr = (cfg.mode === 'value') ? null : await ensureCounter()

  const startNonce = await wallet.getNonce()
  const startBlock = await provider.getBlockNumber()
  const balBefore = await provider.getBalance(wallet.address)

  if (balBefore < BigInt(cfg.n) * 100_000_000_000_000n) {
    throw new Error(`probe balance ${ethers.formatEther(balBefore)} too low for ${cfg.n} txs`)
  }

  // Pre-flight: refuse to fire if probe wallet has stale pending (nonce gap
  // or stuck txs hogging the per-sender cap). txpool_content tells us truth
  // since eth_getTransactionCount(addr,'pending') ignores mempool.
  try {
    const pool = await provider.send('txpool_content', [])
    const lower = wallet.address.toLowerCase()
    const myPending = pool?.pending?.[lower] || pool?.pending?.[wallet.address] || {}
    const pendingNonces = Object.keys(myPending).map((k) => Number(k)).sort((a, b) => a - b)
    if (pendingNonces.length > 0) {
      const lowest = pendingNonces[0]
      const gap = lowest > startNonce
      throw new Error(
        `probe ${wallet.address} has ${pendingNonces.length} stale pending tx (nonce ${pendingNonces[0]}..${pendingNonces[pendingNonces.length - 1]})` +
        (gap ? `, NONCE GAP between latest=${startNonce} and lowest pending=${lowest} — wait for TTL eviction (6h) or operator mempool reset` : ', wait for mining or use replacement-by-fee'),
      )
    }
    if (cfg.n + pendingNonces.length > cfg.maxPerSenderCap) {
      throw new Error(`N=${cfg.n} + ${pendingNonces.length} stale would exceed safe per-sender cap ${cfg.maxPerSenderCap}`)
    }
  } catch (e) {
    if (e.code !== -32601 /* txpool_content not supported */) throw e
    console.log('[stress] txpool_content not supported — skipping pre-flight gap check')
  }

  // Pre-sign all N txs offline.
  const gasPrice = BigInt(cfg.gasPriceGwei) * 1_000_000_000n
  console.log(`[stress] pre-signing ${cfg.n} txs (mode=${cfg.mode}, startNonce=${startNonce}) ...`)
  const signed = []
  for (let i = 0; i < cfg.n; i++) {
    const useCall = cfg.mode === 'call' || (cfg.mode === 'mixed' && i % 2 === 1)
    const txReq = useCall
      ? { chainId: BigInt(cfg.chainId), type: 2, nonce: startNonce + i, to: counterAddr, data: '0x', gasLimit: 50000, maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
      : { chainId: BigInt(cfg.chainId), type: 2, nonce: startNonce + i, to: ethers.ZeroAddress, value: 1n, gasLimit: 21000, maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
    signed.push(await wallet.signTransaction(txReq))
  }
  console.log(`[stress] firing ${cfg.n} eth_sendRawTransaction in parallel ...`)

  // Bypass ethers' built-in retry on -32603 — when we hit a per-sender
  // mempool cap, retrying just burns wall clock until our outer deadline.
  const sendRaw = async (raw, i) => {
    const r = await fetch(cfg.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'eth_sendRawTransaction', params: [raw] }),
    }).then((r) => r.json())
    if (r.error) {
      const err = new Error(r.error.message)
      err.code = r.error.code
      throw err
    }
    return r.result
  }

  const t0 = Date.now()
  const submitResults = await Promise.allSettled(
    signed.map((raw, i) => sendRaw(raw, i).then((h) => ({ i, hash: h, submittedAt: Date.now() }))),
  )
  const submitMs = Date.now() - t0
  const submitted = submitResults.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  const submitFailed = submitResults
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === 'rejected')
    .map(({ r, i }) => ({ i, err: r.reason?.message || String(r.reason) }))
  const mempoolCapHits = submitFailed.filter((f) => /exceeds max pending tx limit|mempool.*full|known transaction/i.test(f.err)).length
  console.log(`[stress] submitted=${submitted.length}/${cfg.n} in ${submitMs}ms  failed=${submitFailed.length}`)
  if (submitFailed.length > 0) {
    console.log(`[stress] sample submit fails: ${JSON.stringify(submitFailed.slice(0, 3))}`)
  }

  // Wait for receipts.
  const waitDeadline = Date.now() + cfg.totalTimeoutMs
  const receipts = await Promise.allSettled(submitted.map(async ({ hash, submittedAt }) => {
    const remaining = Math.max(1000, waitDeadline - Date.now())
    const r = await Promise.race([
      provider.waitForTransaction(hash),
      new Promise((_, rej) => setTimeout(() => rej(new Error('inclusion timeout')), remaining)),
    ])
    return { hash, blockNumber: r.blockNumber, status: r.status, gasUsed: r.gasUsed, latencyMs: Date.now() - submittedAt }
  }))
  const totalMs = Date.now() - t0

  const ok = receipts.filter((r) => r.status === 'fulfilled' && r.value.status === 1).map((r) => r.value)
  const failedRcpt = receipts
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === 'rejected' || r.value?.status !== 1)
    .map(({ r, i }) => ({ i, err: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : `status=${r.value.status}` }))

  const latencies = ok.map((r) => r.latencyMs)
  const blocksTouched = new Set(ok.map((r) => r.blockNumber))
  const endBlock = await provider.getBlockNumber()
  const balAfter = await provider.getBalance(wallet.address)
  const gasSpent = balBefore - balAfter
  const tps = ok.length > 0 ? (ok.length / totalMs) * 1000 : 0

  const stats = {
    startedAt,
    finishedAt: new Date().toISOString(),
    cfg: { n: cfg.n, mode: cfg.mode, gasPriceGwei: cfg.gasPriceGwei, counterAddr },
    nonceRange: [startNonce, startNonce + cfg.n - 1],
    blockRange: [startBlock, endBlock],
    submitted: submitted.length,
    submitFailed: submitFailed.length,
    mempoolCapHits,
    confirmed: ok.length,
    receiptFailed: failedRcpt.length,
    submitMs,
    totalMs,
    tps: Number(tps.toFixed(2)),
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: pct(latencies, 50),
      p95: pct(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    blocksTouched: blocksTouched.size,
    blocksAdvanced: endBlock - startBlock,
    gasSpent_COC: Number(ethers.formatEther(gasSpent)).toFixed(6),
    failures: failedRcpt.slice(0, 5),
  }

  // Pass/fail evaluation
  stats.pass = (
    stats.confirmed === cfg.n &&
    stats.submitFailed === 0 &&
    stats.latencyMs.p95 <= cfg.p95LimitMs &&
    stats.tps >= cfg.tpsMin
  )
  stats.passReasons = []
  if (stats.confirmed !== cfg.n) stats.passReasons.push(`confirmed ${stats.confirmed}/${cfg.n}`)
  if (stats.submitFailed > 0) stats.passReasons.push(`${stats.submitFailed} submit fails`)
  if (stats.latencyMs.p95 > cfg.p95LimitMs) stats.passReasons.push(`p95 ${stats.latencyMs.p95}ms > ${cfg.p95LimitMs}ms`)
  if (stats.tps < cfg.tpsMin) stats.passReasons.push(`tps ${stats.tps} < ${cfg.tpsMin}`)

  return stats
}

export { runStress }

if (import.meta.url === `file://${process.argv[1]}`) {
  runStress()
    .then((stats) => {
      const head = stats.pass ? '\x1b[32mSTRESS-OK\x1b[0m' : '\x1b[31mSTRESS-FAIL\x1b[0m'
      console.log()
      console.log(`${head}  ${stats.confirmed}/${cfg.n} confirmed  tps=${stats.tps}  p50=${stats.latencyMs.p50}ms  p95=${stats.latencyMs.p95}ms  blocks=${stats.blocksTouched}  gas=${stats.gasSpent_COC} COC${stats.mempoolCapHits > 0 ? `  mempoolCap=${stats.mempoolCapHits}` : ''}`)
      if (!stats.pass) console.log(`        reasons: ${stats.passReasons.join('; ')}`)
      if (cfg.reportJson) writeFileSync(cfg.reportJson, JSON.stringify(stats, null, 2))
      process.exit(stats.pass ? 0 : 1)
    })
    .catch((e) => {
      console.error('stress-probe crashed:', e)
      process.exit(2)
    })
}
