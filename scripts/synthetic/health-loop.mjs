#!/usr/bin/env node
// 30-minute health loop coordinator.
//
// Each tick:
//   1. run synthetic checks (passive HTTP/RPC invariants)        — check-prod.mjs
//   2. run active probes    (real txs, deploy, call, estimateGas) — active-probe.mjs
//   3. inspect results for known auto-remediable failures and
//      invoke the corresponding remediator (rate-limited):
//        - faucet.balance fail → remediate.refundFaucet()
//        - rpc.blockFreshness fail → remediate.restartValidators()
//   4. write structured JSON report
//
// Synthetic check loop (check-prod.mjs --watch) is a SEPARATE pm2 process
// (coc-synthetic) running at 60s cadence for fast MTTD on prod-side
// availability. This loop runs at 30 min cadence because active probes
// each emit ~4 on-chain txs, and we don't want to spam the chain.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runSyntheticCheck } from './check-prod.mjs'
import { runActiveProbe } from './active-probe.mjs'
import { runStress } from './stress-probe.mjs'
import { refundFaucet, restartValidators } from './remediate.mjs'

const cfg = {
  intervalMs: Number(process.env.HEALTH_LOOP_INTERVAL_SEC || '1800') * 1000, // 30 min
  reportDir: process.env.HEALTH_REPORT_DIR || '/var/log/coc-synthetic',
  // Run stress every N ticks (default 4 = ~2 hours). Stress pushes ~32 txs
  // through mempool + EVM and is heavier than the standard active probe.
  stressEveryNTicks: Number(process.env.HEALTH_STRESS_EVERY || '4'),
}

let tickCounter = 0

if (!existsSync(cfg.reportDir)) mkdirSync(cfg.reportDir, { recursive: true })

function checkFailed(report, name) {
  return (report?.results || []).find((r) => r.name === name && !r.pass) != null
}

async function tick() {
  const startedAt = new Date().toISOString()
  console.log(`\n[health-loop] tick ${startedAt}`)

  // 1. passive checks
  console.log(`[health-loop] running synthetic checks ...`)
  let synth = { ok: false, results: [], error: 'not-run' }
  try {
    synth = await runSyntheticCheck()
  } catch (e) {
    synth = { ok: false, results: [], error: e instanceof Error ? e.message : String(e) }
  }

  // 2. active probes
  console.log(`[health-loop] running active probes ...`)
  let active = { ok: false, error: 'not-run' }
  try {
    active = await runActiveProbe()
  } catch (e) {
    active = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // 2b. stress probe — every Nth tick
  let stress = null
  tickCounter += 1
  if (tickCounter % cfg.stressEveryNTicks === 0) {
    console.log(`[health-loop] running stress probe (tick ${tickCounter}, every ${cfg.stressEveryNTicks}) ...`)
    try {
      stress = await runStress()
      console.log(`[health-loop] stress: ${stress.pass ? 'PASS' : 'FAIL'} confirmed=${stress.confirmed}/${stress.cfg?.n} tps=${stress.tps} p95=${stress.latencyMs?.p95}ms`)
    } catch (e) {
      stress = { pass: false, error: e instanceof Error ? e.message : String(e) }
      console.log(`[health-loop] stress probe crashed: ${stress.error}`)
    }
  }

  // 3. remediation
  const actions = []
  if (checkFailed(synth, 'faucet.balance')) {
    console.log(`[health-loop] faucet.balance FAIL — invoking refundFaucet`)
    const r = await refundFaucet().catch((e) => ({ tried: false, ok: false, msg: String(e) }))
    actions.push({ action: 'refund-faucet', ...r })
    console.log(`[health-loop] refundFaucet: ${r.msg}`)
  }
  if (checkFailed(synth, 'rpc.blockFreshness')) {
    console.log(`[health-loop] rpc.blockFreshness FAIL — invoking restartValidators`)
    const r = await restartValidators({ reason: 'synthetic.blockFreshness' }).catch((e) => ({ tried: false, ok: false, msg: String(e) }))
    actions.push({ action: 'restart-validators', ...r })
    console.log(`[health-loop] restartValidators: ${r.msg}`)
  }

  // 4. report
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    synthetic: { ok: synth.ok, fails: (synth.results || []).filter((r) => !r.pass).map((r) => r.name) },
    active: { ok: active.ok, fails: (active.results || []).filter((r) => !r.pass).map((r) => r.name), error: active.error },
    stress: stress ? { pass: stress.pass, confirmed: stress.confirmed, tps: stress.tps, p95: stress.latencyMs?.p95, error: stress.error } : null,
    actions,
  }
  const fname = join(cfg.reportDir, `tick-${startedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(fname, JSON.stringify(report, null, 2))
  writeFileSync(join(cfg.reportDir, 'last-health.json'), JSON.stringify(report, null, 2))

  const status = report.synthetic.ok && report.active.ok ? 'HEALTHY' : (actions.some((a) => a.tried && a.ok) ? 'REMEDIATED' : 'DEGRADED')
  console.log(`[health-loop] ${status} synthetic.ok=${report.synthetic.ok} active.ok=${report.active.ok} actions=${actions.length}`)
}

async function main() {
  console.log(`[health-loop] starting, interval=${cfg.intervalMs / 1000}s, report=${cfg.reportDir}`)
  // initial run on startup
  await tick().catch((e) => console.error('[health-loop] tick crashed:', e))
  setInterval(() => {
    tick().catch((e) => console.error('[health-loop] tick crashed:', e))
  }, cfg.intervalMs)
}

main()
