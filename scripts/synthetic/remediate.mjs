#!/usr/bin/env node
// Bounded auto-remediation for known prod failure modes.
//
// Strictly limited to two actions, each with a strict per-window rate limit
// persisted to /var/lib/coc-synthetic/state.json. NEVER write a remediator
// that mutates source code or rolls forward to a state harder to undo than
// what the operator could do by hand. Anything beyond this scope (e.g.
// rebuilding a node, wiping leveldb) must remain manual.
//
//   1. refund-faucet  — fund the testnet faucet hot-wallet from the
//                       DEPLOYER_PK account when balance drops below
//                       FAUCET_MIN_COC (default 1000). Refund amount:
//                       FAUCET_REFUND_COC (default 50000). Rate: 1/day.
//
//   2. restart-validators — atomic stop+start of all 5 validators when
//                           block freshness > BLOCK_FRESHNESS_LIMIT_SEC
//                           (default 300). Restart strategy proven 2026-05-12
//                           against the poison-block stall. Rate: 1/hour.
//
// Each action returns { tried, ok, msg } and is independently invokable.

import { ethers } from 'ethers'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { HARDHAT_DEV_PRIVATE_KEYS, resolvePrivateKeyForRpc } from '../lib/key-safety.mjs'

const cfg = {
  rpc: process.env.PROBE_RPC || 'https://clawchain.io/api/testnet/rpc',
  chainId: Number(process.env.PROBE_CHAIN_ID || '88780'),
  faucetAddr: process.env.FAUCET_ADDR || '0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF',
  faucetMin: Number(process.env.FAUCET_MIN_COC || '1000'),
  faucetRefund: Number(process.env.FAUCET_REFUND_COC || '50000'),
  blockFreshnessLimitSec: Number(process.env.BLOCK_FRESHNESS_LIMIT_SEC || '300'),
  faucetMinIntervalMs: 23 * 3600 * 1000, // once per day
  restartMinIntervalMs: 55 * 60 * 1000,  // once per hour
  stateFile: process.env.REMEDIATE_STATE || '/var/lib/coc-synthetic/state.json',
  sshKey: process.env.SSH_KEY || '/root/.ssh/coc-automation',
  validators: [
    { name: 'v1', host: '209.74.64.88',    unit: 'coc-node@88' },
    { name: 'v2', host: '159.198.44.136',  unit: 'coc-node@1'  },
    { name: 'v3', host: '199.192.16.79',   unit: 'coc-node@88' },
    { name: 'v4', host: '159.198.36.3',    unit: 'coc-node@1'  },
    { name: 'v5', host: '159.198.36.25',   unit: 'coc-node@1'  },
  ],
}
cfg.deployerPk = resolvePrivateKeyForRpc({
  envValue: process.env.DEPLOYER_PK,
  envName: 'DEPLOYER_PK',
  fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[0],
  rpcUrl: cfg.rpc,
  label: 'synthetic remediation',
})

function loadState() {
  try {
    return JSON.parse(readFileSync(cfg.stateFile, 'utf8'))
  } catch {
    return {}
  }
}
function saveState(s) {
  const dir = cfg.stateFile.substring(0, cfg.stateFile.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(cfg.stateFile, JSON.stringify(s, null, 2))
}

function provider() {
  // staticNetwork avoids ethers' eth_chainId auto-detect 5s timeout on
  // hairpin-NAT / TLS cold-start (prod-2 reaching its own public URL).
  return new ethers.JsonRpcProvider(
    cfg.rpc,
    { chainId: cfg.chainId, name: 'ChainOfClaw' },
    { staticNetwork: ethers.Network.from({ chainId: cfg.chainId, name: 'ChainOfClaw' }) },
  )
}

// ---------- 1. refund-faucet ----------

export async function refundFaucet({ dryRun = false } = {}) {
  const p = provider()
  const wei = await p.getBalance(cfg.faucetAddr)
  const coc = Number(wei) / 1e18
  if (coc >= cfg.faucetMin) {
    return { tried: false, ok: true, msg: `faucet bal ${coc.toFixed(2)} COC ≥ ${cfg.faucetMin}, no refund needed` }
  }

  const st = loadState()
  const last = Number(st.lastFaucetRefundAt || 0)
  const since = Date.now() - last
  if (since < cfg.faucetMinIntervalMs) {
    const mins = Math.floor((cfg.faucetMinIntervalMs - since) / 60000)
    return { tried: false, ok: false, msg: `faucet bal ${coc.toFixed(2)} < ${cfg.faucetMin} BUT rate-limit (${mins} min until next refund allowed)` }
  }

  if (dryRun) return { tried: false, ok: true, msg: `[dry-run] would refund ${cfg.faucetRefund} COC` }

  const deployer = new ethers.Wallet(cfg.deployerPk, p)
  const dWei = await p.getBalance(deployer.address)
  const need = BigInt(cfg.faucetRefund) * 10n ** 18n
  if (dWei < need) {
    return { tried: false, ok: false, msg: `deployer bal ${Number(dWei) / 1e18} < refund ${cfg.faucetRefund}` }
  }
  const tx = await deployer.sendTransaction({ to: cfg.faucetAddr, value: need })
  const r = await tx.wait()
  if (r.status !== 1) return { tried: true, ok: false, msg: `refund tx ${tx.hash} status=${r.status}` }
  st.lastFaucetRefundAt = Date.now()
  st.lastFaucetRefundTx = tx.hash
  st.lastFaucetRefundCOC = cfg.faucetRefund
  saveState(st)
  return { tried: true, ok: true, msg: `refunded ${cfg.faucetRefund} COC tx=${tx.hash.slice(0, 10)}.. block=${r.blockNumber}` }
}

// ---------- 2. restart-validators ----------

export async function restartValidators({ dryRun = false, reason = 'block-stall' } = {}) {
  if (!existsSync(cfg.sshKey)) {
    return { tried: false, ok: false, msg: `ssh key ${cfg.sshKey} not found — cannot restart` }
  }

  // Re-confirm stall — protect against transient false alarm.
  const p = provider()
  try {
    const head = await p.getBlock('latest')
    const age = Math.floor(Date.now() / 1000) - Number(head.timestamp)
    if (age <= cfg.blockFreshnessLimitSec) {
      return { tried: false, ok: true, msg: `head age ${age}s ≤ ${cfg.blockFreshnessLimitSec} — stall cleared, abort restart` }
    }
  } catch (e) {
    return { tried: false, ok: false, msg: `eth_getBlock failed before restart: ${String(e)}` }
  }

  const st = loadState()
  const last = Number(st.lastValidatorRestartAt || 0)
  const since = Date.now() - last
  if (since < cfg.restartMinIntervalMs) {
    const mins = Math.floor((cfg.restartMinIntervalMs - since) / 60000)
    return { tried: false, ok: false, msg: `chain stalled BUT rate-limit (${mins} min until next restart allowed)` }
  }

  if (dryRun) return { tried: false, ok: true, msg: `[dry-run] would atomic stop+start ${cfg.validators.length} validators` }

  // Atomic stop all 5, sleep 5s, start all 5 — proven recipe 2026-05-12.
  const exec = (host, cmd) =>
    new Promise((resolve) => {
      try {
        const out = execFileSync('ssh', [
          '-i', cfg.sshKey,
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ConnectTimeout=8',
          `root@${host}`, cmd,
        ], { encoding: 'utf8', timeout: 20000 })
        resolve({ ok: true, out })
      } catch (e) {
        resolve({ ok: false, out: String(e) })
      }
    })

  const stopResults = await Promise.all(cfg.validators.map((v) => exec(v.host, `systemctl stop ${v.unit}`)))
  const stopFails = stopResults.filter((r) => !r.ok)
  await new Promise((r) => setTimeout(r, 5000))
  const startResults = await Promise.all(cfg.validators.map((v) => exec(v.host, `systemctl start ${v.unit}`)))
  const startFails = startResults.filter((r) => !r.ok)

  st.lastValidatorRestartAt = Date.now()
  st.lastValidatorRestartReason = reason
  st.lastValidatorRestartStopFails = stopFails.length
  st.lastValidatorRestartStartFails = startFails.length
  saveState(st)

  // Wait up to 60s for chain to advance.
  let advanced = false
  const startHead = await p.getBlockNumber().catch(() => 0)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    try {
      const nowHead = await p.getBlockNumber()
      if (nowHead > startHead) { advanced = true; break }
    } catch { /* ignore */ }
  }
  return {
    tried: true,
    ok: advanced && stopFails.length === 0 && startFails.length === 0,
    msg: `stop=${cfg.validators.length - stopFails.length}/${cfg.validators.length} start=${cfg.validators.length - startFails.length}/${cfg.validators.length} chainAdvanced=${advanced}`,
  }
}

// ---------- CLI ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  const action = process.argv[2]
  const dryRun = process.argv.includes('--dry-run')
  const handlers = { 'refund-faucet': refundFaucet, 'restart-validators': restartValidators }
  if (!handlers[action]) {
    console.error(`usage: ${process.argv[1]} <refund-faucet|restart-validators> [--dry-run]`)
    process.exit(2)
  }
  handlers[action]({ dryRun })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 1)
    })
    .catch((e) => {
      console.error(e)
      process.exit(2)
    })
}
