#!/usr/bin/env node
// COC daily summary — aggregates 24h of health-loop ticks into a one-page
// digest. Run via cron / pm2 cron / on-demand.
//
//   node daily-summary.mjs                # print to stdout
//   node daily-summary.mjs --hours 24
//   node daily-summary.mjs --log /root/.pm2/logs/coc-health-loop-out.log

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function arg(flag, def) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def
}

const cfg = {
  hours: Number(arg('--hours', '24')),
  log: arg('--log', '/root/.pm2/logs/coc-health-loop-out.log'),
}

const lines = readFileSync(cfg.log, 'utf8').split('\n')
const since = Date.now() - cfg.hours * 3600 * 1000

const ticks = []
let cur = null
for (const ln of lines) {
  const m = ln.match(/^\[health-loop\] tick (\S+)/)
  if (m) {
    if (cur) ticks.push(cur)
    cur = { ts: m[1], time: Date.parse(m[1]), synth: null, active: null, fails: [] }
    continue
  }
  if (!cur) continue
  const sm = ln.match(/^\s*\d+:\d+:\d+\s+(?:\x1b\[\d+m\s*)?(PASS|FAIL|WARN)(?:\x1b\[0m)?\s+(\S+)/)
  if (sm) {
    const [, level, name] = sm
    if (level === 'FAIL') cur.fails.push(name)
  }
  if (ln.includes('HEALTHY')) cur.synth = true
  else if (ln.includes('DEGRADED')) cur.synth = false
  if (ln.includes('ACTIVE-OK')) cur.active = true
  else if (ln.includes('ACTIVE-FAIL')) cur.active = false
}
if (cur) ticks.push(cur)

const recent = ticks.filter((t) => t.time >= since)
const total = recent.length
const healthy = recent.filter((t) => t.synth === true).length
const degraded = recent.filter((t) => t.synth === false).length
const activeOk = recent.filter((t) => t.active === true).length
const failCounts = {}
for (const t of recent) for (const f of t.fails) failCounts[f] = (failCounts[f] || 0) + 1

console.log(`COC daily summary — last ${cfg.hours}h ending ${new Date().toISOString()}`)
console.log('='.repeat(72))
console.log(`Total ticks:    ${total}`)
console.log(`HEALTHY:        ${healthy} (${(100 * healthy / Math.max(1, total)).toFixed(1)}%)`)
console.log(`DEGRADED:       ${degraded}`)
console.log(`Active-probe OK: ${activeOk}/${total}`)
console.log()
console.log('Per-check failure counts:')
const sorted = Object.entries(failCounts).sort((a, b) => b[1] - a[1])
if (sorted.length === 0) console.log('  (no failures)')
else for (const [name, n] of sorted) console.log(`  ${name.padEnd(36)} ${n}`)

if (degraded > 0) {
  console.log()
  console.log('Most recent DEGRADED:')
  const last = recent.filter((t) => t.synth === false).slice(-3)
  for (const t of last) console.log(`  ${t.ts}  fails=${t.fails.join(',')}`)
}
