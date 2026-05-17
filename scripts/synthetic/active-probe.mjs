#!/usr/bin/env node
// COC active chain probe.
//
// Drives a small, deterministic load against the testnet to verify it is
// not just "responding to RPC" but actually accepting txs, mining blocks,
// executing EVM, and persisting state. Catches the class of failure where
// RPC is up + block freshness check passes but EVM is rejecting all
// proposals (poison-block stall pattern seen 2026-05-12).
//
// Probes (default cadence: 30 min, see health-loop.mjs):
//   1. value-transfer  — 1 wei to a throwaway random address
//   2. contract-deploy — 27-byte counter (slot 0 += 1 per call)
//   3. contract-call   — increments counter twice, eth_getStorageAt verifies
//   4. estimate-gas    — eth_estimateGas on the probed contract
//
// Each probe has its own timeout and is reported independently. The whole
// run exits non-zero if any probe failed (so a systemd timer / pm2 wrapper
// can alert).
//
// Env knobs:
//   PROBE_RPC               default https://clawchain.io/api/testnet/rpc
//   PROBE_CHAIN_ID          default 88780
//   PROBE_PK                required for public RPCs; localhost/devnet uses Hardhat #5
//   PROBE_TX_TIMEOUT_MS     default 30000 (per-tx wait)
//   PROBE_REPORT_JSON       optional path; if set, writes report JSON here

import { ethers } from 'ethers'
import { writeFileSync } from 'node:fs'
import { HARDHAT_DEV_PRIVATE_KEYS, resolvePrivateKeyForRpc } from '../lib/key-safety.mjs'

const cfg = {
  rpc: process.env.PROBE_RPC || 'https://clawchain.io/api/testnet/rpc',
  chainId: Number(process.env.PROBE_CHAIN_ID || '88780'),
  txTimeoutMs: Number(process.env.PROBE_TX_TIMEOUT_MS || '30000'),
  reportJson: process.env.PROBE_REPORT_JSON || null,
}
cfg.probePk = resolvePrivateKeyForRpc({
  envValue: process.env.PROBE_PK,
  envName: 'PROBE_PK',
  fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[5],
  rpcUrl: cfg.rpc,
  label: 'synthetic active probe',
})

// Hand-assembled minimal counter contract (27 bytes total) — see ./README.md.
// init code stores 0 at slot 0, returns runtime (10 bytes). Runtime SLOAD's
// slot 0, adds 1, SSTORE's back. Read state via eth_getStorageAt(addr, 0).
const COUNTER_BYTECODE = '0x6000600055600a6011600039600a6000f360005460010160005500'

// staticNetwork avoids ethers' eth_chainId auto-detect timeout on cold-start
// (5s default is too tight when first connection has to warm a TLS/hairpin path).
const provider = new ethers.JsonRpcProvider(
  cfg.rpc,
  { chainId: cfg.chainId, name: 'ChainOfClaw' },
  { staticNetwork: ethers.Network.from({ chainId: cfg.chainId, name: 'ChainOfClaw' }) },
)
const wallet = new ethers.Wallet(cfg.probePk, provider)

function pad(s, n) { return String(s).padEnd(n) }
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ])
}

async function probeBalance() {
  const wei = await provider.getBalance(wallet.address)
  const coc = Number(wei) / 1e18
  if (coc < 1) throw new Error(`probe wallet ${wallet.address} balance ${coc.toFixed(4)} COC < 1 — fund needed`)
  return `${wallet.address} ${coc.toFixed(2)} COC`
}

async function probeValueTransfer() {
  const dest = ethers.Wallet.createRandom().address
  const tx = await wallet.sendTransaction({ to: dest, value: 1n })
  const r = await withTimeout(tx.wait(), cfg.txTimeoutMs, 'value-transfer')
  if (r.status !== 1) throw new Error(`value-transfer status=${r.status}`)
  return `tx=${tx.hash.slice(0, 10)}.. block=${r.blockNumber} gas=${r.gasUsed}`
}

async function probeContractDeploy() {
  const tx = await wallet.sendTransaction({ data: COUNTER_BYTECODE })
  const r = await withTimeout(tx.wait(), cfg.txTimeoutMs, 'contract-deploy')
  if (r.status !== 1) throw new Error(`deploy status=${r.status}`)
  if (!r.contractAddress) throw new Error('deploy: no contractAddress')
  // Verify code was stored on-chain.
  const code = await provider.getCode(r.contractAddress)
  if (code === '0x' || code.length < 6) throw new Error(`deploy: contract has no code (${code})`)
  return { addr: r.contractAddress, block: r.blockNumber, codeLen: (code.length - 2) / 2 }
}

async function probeContractCall(addr) {
  const slot0 = (lbl) => provider.getStorage(addr, 0).then((h) => {
    if (typeof h !== 'string') throw new Error(`${lbl}: getStorage returned non-string`)
    return BigInt(h)
  })

  const before = await slot0('before')
  const tx1 = await wallet.sendTransaction({ to: addr, data: '0x' })
  const r1 = await withTimeout(tx1.wait(), cfg.txTimeoutMs, 'contract-call#1')
  if (r1.status !== 1) throw new Error(`call#1 status=${r1.status}`)
  const mid = await slot0('mid')
  if (mid !== before + 1n) throw new Error(`call#1 slot0 ${before}→${mid}, expected +1`)

  const tx2 = await wallet.sendTransaction({ to: addr, data: '0x' })
  const r2 = await withTimeout(tx2.wait(), cfg.txTimeoutMs, 'contract-call#2')
  if (r2.status !== 1) throw new Error(`call#2 status=${r2.status}`)
  const after = await slot0('after')
  if (after !== before + 2n) throw new Error(`call#2 slot0 ${before}→${after}, expected +2`)

  return `slot0 ${before}→${after} (+2)  gas1=${r1.gasUsed} gas2=${r2.gasUsed}`
}

async function probeEstimateGas(addr) {
  const est = await provider.estimateGas({ from: wallet.address, to: addr, data: '0x' })
  if (est < 21000n) throw new Error(`estimateGas ${est} < 21000`)
  return `${est} gas`
}

// ----- runner -----

async function runOnce() {
  const startedAt = new Date().toISOString()
  const out = []

  const run = async (name, fn) => {
    const t0 = Date.now()
    try {
      const msg = await fn()
      out.push({ name, pass: true, msg: typeof msg === 'string' ? msg : JSON.stringify(msg), latency_ms: Date.now() - t0 })
      return msg
    } catch (e) {
      out.push({ name, pass: false, msg: e instanceof Error ? e.message : String(e), latency_ms: Date.now() - t0 })
      return null
    }
  }

  await run('balance', probeBalance)
  await run('value-transfer', probeValueTransfer)
  const deploy = await run('contract-deploy', probeContractDeploy)
  if (deploy?.addr) {
    await run('contract-call', () => probeContractCall(deploy.addr))
    await run('estimate-gas', () => probeEstimateGas(deploy.addr))
  }

  const ok = out.every((r) => r.pass)
  const ts = new Date().toISOString().slice(11, 19)
  for (const r of out) {
    const tag = r.pass ? '\x1b[32m PASS\x1b[0m' : '\x1b[31m FAIL\x1b[0m'
    console.log(`${ts} ${tag} ${pad(r.name, 18)} ${pad(r.latency_ms + 'ms', 8)} ${r.msg}`)
  }
  console.log(`${ts} ${ok ? '\x1b[32mACTIVE-OK\x1b[0m' : '\x1b[31mACTIVE-FAIL\x1b[0m'} ${out.filter((r) => r.pass).length}/${out.length} pass\n`)

  return { startedAt, ok, results: out }
}

export { runOnce as runActiveProbe }

if (import.meta.url === `file://${process.argv[1]}`) {
  runOnce()
    .then((r) => {
      if (cfg.reportJson) writeFileSync(cfg.reportJson, JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 1)
    })
    .catch((e) => {
      console.error('active-probe runner crashed:', e)
      process.exit(2)
    })
}
