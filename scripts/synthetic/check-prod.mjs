#!/usr/bin/env node
// COC production synthetic E2E check loop.
//
// Each check returns { pass, msg, latency_ms }. The script prints a
// line per check (+ a summary), exits non-zero if any critical check
// failed, and writes a structured JSON report to --json <path> if given.
//
// Run modes:
//   node check-prod.mjs                  # one-shot, exit code reflects health
//   node check-prod.mjs --watch          # repeat every CHECK_INTERVAL_SEC (default 60)
//   node check-prod.mjs --json /tmp/r.json
//
// Env knobs:
//   COC_RPC_URL              default https://clawchain.io/api/testnet/rpc
//   COC_WS_URL               default wss://clawchain.io/api/testnet/ws
//   COC_CHAIN_ID             default 88780
//   COC_FAUCET_URL           default https://faucet.clawchain.io
//   COC_FAUCET_ADDRESS       default 0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF
//   COC_FAUCET_MIN_BALANCE   default 100 (COC)
//   COC_WEBSITE_URL          default https://clawchain.io
//   COC_EXPLORER_URL         default https://explorer.clawchain.io
//   COC_IPFS_URL             default https://ipfs.clawchain.io
//   COC_BLOCK_FRESHNESS_SEC  default 60
//   CHECK_INTERVAL_SEC       default 60

import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { URL } from 'node:url'

const cfg = {
  rpcUrl: process.env.COC_RPC_URL || 'https://clawchain.io/api/testnet/rpc',
  wsUrl: process.env.COC_WS_URL || 'wss://clawchain.io/api/testnet/ws',
  chainId: Number(process.env.COC_CHAIN_ID || '88780'),
  faucetUrl: process.env.COC_FAUCET_URL || 'https://faucet.clawchain.io',
  faucetAddr: process.env.COC_FAUCET_ADDRESS || '0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF',
  faucetMinBalance: Number(process.env.COC_FAUCET_MIN_BALANCE || '100'),
  websiteUrl: process.env.COC_WEBSITE_URL || 'https://clawchain.io',
  explorerUrl: process.env.COC_EXPLORER_URL || 'https://explorer.clawchain.io',
  ipfsUrl: process.env.COC_IPFS_URL || 'https://ipfs.clawchain.io',
  blockFreshnessSec: Number(process.env.COC_BLOCK_FRESHNESS_SEC || '60'),
  intervalSec: Number(process.env.CHECK_INTERVAL_SEC || '60'),
  timeoutMs: Number(process.env.CHECK_TIMEOUT_MS || '15000'),
}

// ---------- helpers ----------

async function fetchWithTimeout(url, opts = {}, ms = cfg.timeoutMs) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function rpc(method, params = []) {
  const res = await fetchWithTimeout(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
  const j = await res.json()
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`)
  return j.result
}

function hexToBigInt(h) {
  return typeof h === 'string' && h.startsWith('0x') ? BigInt(h) : BigInt(h ?? 0)
}

function weiToCOC(wei) {
  return Number(wei) / 1e18
}

// WebSocket handshake on a wss:// URL via raw TCP (no extra deps).
async function wsHandshake(wsUrl, timeoutMs = cfg.timeoutMs) {
  const u = new URL(wsUrl)
  const tls = u.protocol === 'wss:'
  const port = u.port ? Number(u.port) : tls ? 443 : 80
  const host = u.hostname
  const path = u.pathname + u.search

  // Build a minimal HTTP/1.1 Upgrade request.
  const key = 'dGhlIHNhbXBsZSBub25jZQ=='
  const req =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`

  return new Promise((resolve, reject) => {
    let socket
    const t0 = Date.now()
    const finish = (err, status) => {
      try { socket?.destroy() } catch {}
      if (err) reject(err)
      else resolve({ status, latency_ms: Date.now() - t0 })
    }
    const onTimeout = setTimeout(() => finish(new Error(`WS timeout ${timeoutMs}ms`)), timeoutMs)
    const tcpConnect = () => {
      if (tls) {
        // dynamic import to avoid loading tls if unused
        import('node:tls').then((tlsMod) => {
          socket = tlsMod.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] }, () => socket.write(req))
          attach()
        }).catch((e) => finish(e))
      } else {
        socket = connect({ host, port }, () => socket.write(req))
        attach()
      }
    }
    const attach = () => {
      let buf = ''
      socket.on('data', (d) => {
        buf += d.toString('utf8')
        const i = buf.indexOf('\r\n')
        if (i > 0) {
          const line = buf.slice(0, i)
          const m = line.match(/HTTP\/1\.\d (\d{3})/)
          clearTimeout(onTimeout)
          finish(null, m ? Number(m[1]) : 0)
        }
      })
      socket.on('error', (e) => { clearTimeout(onTimeout); finish(e) })
      socket.on('end', () => { clearTimeout(onTimeout); finish(new Error('WS socket closed before status')) })
    }
    tcpConnect()
  })
}

// ---------- checks ----------

const checks = [
  {
    name: 'rpc.chainId',
    critical: true,
    async run() {
      const r = await rpc('eth_chainId')
      const id = Number(hexToBigInt(r))
      if (id !== cfg.chainId) throw new Error(`RPC chainId ${id} ≠ expected ${cfg.chainId}`)
      return `chainId=${id}`
    },
  },
  {
    name: 'rpc.blockNumber',
    critical: true,
    async run() {
      const r = await rpc('eth_blockNumber')
      const n = Number(hexToBigInt(r))
      if (n < 1) throw new Error(`blockNumber=${n} (chain stalled at genesis?)`)
      return `height=${n}`
    },
  },
  {
    name: 'rpc.blockFreshness',
    critical: true,
    async run() {
      const head = await rpc('eth_getBlockByNumber', ['latest', false])
      const ts = Number(hexToBigInt(head.timestamp))
      const ageSec = Math.floor(Date.now() / 1000) - ts
      if (ageSec > cfg.blockFreshnessSec) throw new Error(`latest block ${ageSec}s old (> ${cfg.blockFreshnessSec}s)`)
      return `age=${ageSec}s`
    },
  },
  {
    name: 'rpc.peerCount',
    critical: false,
    async run() {
      const r = await rpc('net_peerCount')
      const n = Number(hexToBigInt(r))
      if (n < 1) throw new Error(`peerCount=0 (isolated node?)`)
      return `peers=${n}`
    },
  },
  {
    name: 'ws.handshake',
    critical: true,
    async run() {
      const { status, latency_ms } = await wsHandshake(cfg.wsUrl)
      if (status !== 101) throw new Error(`WS upgrade status=${status} (expected 101)`)
      // Threshold sized for cold-start TLS hairpin-NAT (5s observed) +
      // headroom. Warm reconnects measure 30-50ms on prod-2 to itself.
      if (latency_ms > 5000) throw new Error(`WS handshake ${latency_ms}ms > 5000ms`)
      return `101 in ${latency_ms}ms`
    },
  },
  {
    name: 'website.root',
    critical: true,
    async run() {
      const res = await fetchWithTimeout(cfg.websiteUrl + '/zh')
      if (!res.ok) throw new Error(`website /zh HTTP ${res.status}`)
      const body = await res.text()
      if (!/COC|ChainOfClaw|公链/.test(body)) throw new Error('website body missing COC branding')
      return `200 ${body.length}B`
    },
  },
  {
    name: 'website.services',
    critical: false,
    async run() {
      const res = await fetchWithTimeout(cfg.websiteUrl + '/zh/services')
      if (!res.ok) throw new Error(`/zh/services HTTP ${res.status}`)
      const body = await res.text()
      const needles = ['OpenClaw Marketplace', '//claw-mem', '//coc-node', '//coc-soul']
      const miss = needles.filter((n) => !body.includes(n))
      if (miss.length) throw new Error(`/zh/services missing: ${miss.join(', ')}`)
      return `ok (${needles.length}/${needles.length} cards)`
    },
  },
  {
    name: 'explorer.root',
    critical: true,
    async run() {
      const res = await fetchWithTimeout(cfg.explorerUrl + '/')
      if (!res.ok) throw new Error(`explorer / HTTP ${res.status}`)
      const body = await res.text()
      if (/Something went wrong|Server Components/.test(body)) throw new Error('explorer / shows error fallback')
      if (!body.includes(`ChainID: ${cfg.chainId}`)) throw new Error(`explorer footer missing 'ChainID: ${cfg.chainId}'`)
      return `200 chainId-stamped`
    },
  },
  {
    name: 'explorer.validators',
    critical: true,
    async run() {
      const res = await fetchWithTimeout(cfg.explorerUrl + '/validators')
      if (!res.ok) throw new Error(`/validators HTTP ${res.status}`)
      const body = await res.text()
      if (/Something went wrong|Server Components/.test(body)) throw new Error('/validators shows error fallback')
      if (!/Active Validators/.test(body)) throw new Error("/validators body missing 'Active Validators'")
      return 'ok'
    },
  },
  {
    name: 'faucet.health',
    critical: true,
    async run() {
      const res = await fetchWithTimeout(cfg.faucetUrl + '/health')
      if (!res.ok) throw new Error(`/health HTTP ${res.status}`)
      const j = await res.json()
      if (j.status !== 'ok') throw new Error(`/health status=${j.status}`)
      if (j.faucetAddress?.toLowerCase() !== cfg.faucetAddr.toLowerCase()) {
        throw new Error(`/health addr ${j.faucetAddress} ≠ expected ${cfg.faucetAddr}`)
      }
      return `${j.faucetAddress}`
    },
  },
  {
    name: 'faucet.balance',
    critical: true,
    async run() {
      const r = await rpc('eth_getBalance', [cfg.faucetAddr, 'latest'])
      const coc = weiToCOC(hexToBigInt(r))
      if (coc < cfg.faucetMinBalance) {
        throw new Error(`faucet balance ${coc.toFixed(2)} COC < min ${cfg.faucetMinBalance} (refund needed)`)
      }
      return `${coc.toFixed(2)} COC`
    },
  },
  {
    name: 'faucet.status',
    critical: false,
    async run() {
      const res = await fetchWithTimeout(cfg.faucetUrl + '/faucet/status')
      if (!res.ok) throw new Error(`/faucet/status HTTP ${res.status}`)
      const j = await res.json()
      return `bal=${j.balance} drips=${j.totalDrips} daily=${j.dailyDrips}/${j.dailyLimit}`
    },
  },
  {
    name: 'ipfs.root',
    critical: false,
    async run() {
      const res = await fetchWithTimeout(cfg.ipfsUrl + '/')
      if (!res.ok) throw new Error(`ipfs / HTTP ${res.status}`)
      return `200`
    },
  },
]

// ---------- runner ----------

function pad(s, n) { return String(s).padEnd(n) }

// On a server that's also the prod host, the first cross-domain fetch pays
// a hairpin-NAT / TLS-establish cost that can exceed the per-check timeout.
// Warm each public endpoint with a *real* round-trip (POST eth_chainId to
// the RPC, GET /health to the faucet) — GET on a JSON-RPC endpoint returns
// 405 instantly without completing TLS, which doesn't actually prime the
// path. Run warmup twice — first attempt may itself time out under cold NAT.
async function warmup() {
  const rpcPing = () => fetchWithTimeout(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }),
  }, 20_000).catch(() => null)
  const faucetPing = () => fetchWithTimeout(cfg.faucetUrl + '/health', {}, 20_000).catch(() => null)
  await Promise.allSettled([rpcPing(), faucetPing()])
  await Promise.allSettled([rpcPing(), faucetPing()])
}

async function runOnce() {
  await warmup()
  const startedAt = new Date().toISOString()
  const results = []
  for (const c of checks) {
    const t0 = Date.now()
    try {
      const msg = await c.run()
      results.push({ name: c.name, critical: c.critical, pass: true, msg, latency_ms: Date.now() - t0 })
    } catch (e) {
      results.push({
        name: c.name,
        critical: c.critical,
        pass: false,
        msg: e instanceof Error ? e.message : String(e),
        latency_ms: Date.now() - t0,
      })
    }
  }
  const fails = results.filter((r) => !r.pass)
  const criticalFails = fails.filter((r) => r.critical)
  const ok = criticalFails.length === 0

  // pretty line per check
  const ts = new Date().toISOString().slice(11, 19)
  for (const r of results) {
    const tag = r.pass ? '\x1b[32m PASS\x1b[0m' : (r.critical ? '\x1b[31m FAIL\x1b[0m' : '\x1b[33m WARN\x1b[0m')
    console.log(`${ts} ${tag} ${pad(r.name, 24)} ${pad(r.latency_ms + 'ms', 8)} ${r.msg}`)
  }
  console.log(`${ts} ${ok ? '\x1b[32mOK\x1b[0m   ' : '\x1b[31mDEGRADED\x1b[0m'} ${results.filter((r) => r.pass).length}/${results.length} pass, ${fails.length} fail (${criticalFails.length} critical)\n`)

  return { startedAt, ok, results, criticalFails: criticalFails.length, fails: fails.length }
}

function maybeWriteJson(report) {
  const i = process.argv.indexOf('--json')
  if (i >= 0 && process.argv[i + 1]) {
    writeFileSync(process.argv[i + 1], JSON.stringify(report, null, 2))
  }
}

async function main() {
  const watch = process.argv.includes('--watch')
  if (!watch) {
    const r = await runOnce()
    maybeWriteJson(r)
    process.exit(r.ok ? 0 : 1)
  }
  console.log(`[synthetic-check] watch mode, interval=${cfg.intervalSec}s, chainId=${cfg.chainId}, rpc=${cfg.rpcUrl}`)
  for (;;) {
    try {
      const r = await runOnce()
      maybeWriteJson(r)
    } catch (e) {
      console.error('[synthetic-check] runner crashed:', e)
    }
    await sleep(cfg.intervalSec * 1000)
  }
}

// Library export — health-loop.mjs imports this to skip the child-process round-trip.
export { runOnce as runSyntheticCheck }

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
