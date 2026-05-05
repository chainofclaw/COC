#!/usr/bin/env node --experimental-strip-types
/**
 * Phase M2.1 — soak collector.
 *
 * Polls a node's /metrics endpoint every 60s and appends one JSONL line
 * per sample to docs/soak-reports/raw/<runId>.jsonl. Designed to run
 * unattended for 24h via run-24h.sh (nohup wrapper).
 *
 * Usage: node --experimental-strip-types scripts/soak/collect.ts \
 *          --run-id <id> --host <host> --port <metrics-port> [--interval-ms 60000]
 *
 * Failures are warned to stderr but never fatal — we want partial JSONL
 * over an outright miss when the node hiccups mid-soak.
 */

import { argv, exit, stderr } from "node:process"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

interface CollectOpts {
  runId: string
  host: string
  port: number
  intervalMs: number
}

interface SoakSample {
  ts: string
  height: number | null
  peers: number | null
  wireConns: number | null
  txPoolPending: number | null
  blockTimeP95: number | null
  equivocations: number | null
  forkDepthMax: number | null
  consensusState: number | null
}

function parseArgs(args: string[]): CollectOpts {
  let runId: string | null = null
  let host = "199.192.16.79"
  let port = 9101
  let intervalMs = 60_000
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--run-id") runId = args[++i]
    else if (arg === "--host") host = args[++i]
    else if (arg === "--port") port = Number(args[++i])
    else if (arg === "--interval-ms") intervalMs = Number(args[++i])
    else if (arg === "--help" || arg === "-h") {
      stderr.write("usage: collect.ts --run-id <id> [--host h] [--port p] [--interval-ms n]\n")
      exit(2)
    }
  }
  if (!runId) {
    stderr.write("error: --run-id required\n")
    exit(2)
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    stderr.write(`error: --port must be 1..65535, got ${port}\n`)
    exit(2)
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    stderr.write(`error: --interval-ms must be >= 1000, got ${intervalMs}\n`)
    exit(2)
  }
  return { runId, host, port, intervalMs }
}

function parsePromMetric(text: string, name: string): number | null {
  // Match `metric_name <value>` or `metric_name{labels} <value>` at line start.
  const re = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\S+)`, "m")
  const m = text.match(re)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

function parsePromHistogramP95(text: string, name: string): number | null {
  // Approximate p95 from histogram buckets: pick smallest le where
  // cumulative >= 0.95 * total. Falls back to null if metric absent.
  const sumLine = text.match(new RegExp(`^${name}_sum\\s+(\\S+)`, "m"))
  const countLine = text.match(new RegExp(`^${name}_count\\s+(\\S+)`, "m"))
  if (!sumLine || !countLine) return null
  const total = Number(countLine[1])
  if (!Number.isFinite(total) || total <= 0) return null

  const bucketRe = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}\\s+(\\S+)`, "gm")
  const buckets: Array<{ le: number; count: number }> = []
  let bm: RegExpExecArray | null
  while ((bm = bucketRe.exec(text)) !== null) {
    const le = bm[1] === "+Inf" ? Number.POSITIVE_INFINITY : Number(bm[1])
    const count = Number(bm[2])
    if (Number.isFinite(le) && Number.isFinite(count)) buckets.push({ le, count })
  }
  if (buckets.length === 0) return null
  buckets.sort((a, b) => a.le - b.le)
  const target = total * 0.95
  for (const b of buckets) {
    if (b.count >= target) return b.le
  }
  return buckets[buckets.length - 1].le
}

async function fetchMetrics(host: string, port: number): Promise<string> {
  const url = `http://${host}:${port}/metrics`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function tick(opts: CollectOpts, jsonlPath: string): Promise<void> {
  const ts = new Date().toISOString()
  let sample: SoakSample = {
    ts,
    height: null,
    peers: null,
    wireConns: null,
    txPoolPending: null,
    blockTimeP95: null,
    equivocations: null,
    forkDepthMax: null,
    consensusState: null,
  }

  try {
    const text = await fetchMetrics(opts.host, opts.port)
    sample = {
      ts,
      height: parsePromMetric(text, "coc_block_height"),
      peers: parsePromMetric(text, "coc_peers_connected"),
      wireConns: parsePromMetric(text, "coc_wire_connections"),
      txPoolPending: parsePromMetric(text, "coc_tx_pool_pending"),
      blockTimeP95: parsePromHistogramP95(text, "coc_block_time_seconds"),
      equivocations: parsePromMetric(text, "coc_bft_equivocations_total"),
      forkDepthMax: parsePromMetric(text, "coc_fork_choice_max_depth_blocks"),
      consensusState: parsePromMetric(text, "coc_consensus_state"),
    }
  } catch (err) {
    stderr.write(`[soak] ${ts} fetch failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }

  appendFileSync(jsonlPath, JSON.stringify(sample) + "\n")
}

async function main(): Promise<void> {
  const opts = parseArgs(argv.slice(2))
  const jsonlPath = `docs/soak-reports/raw/${opts.runId}.jsonl`
  mkdirSync(dirname(jsonlPath), { recursive: true })

  stderr.write(
    `[soak] starting collector runId=${opts.runId} host=${opts.host}:${opts.port} ` +
    `interval=${opts.intervalMs}ms output=${jsonlPath}\n`,
  )

  // Tick immediately, then on interval.
  await tick(opts, jsonlPath)
  const timer = setInterval(() => {
    void tick(opts, jsonlPath)
  }, opts.intervalMs)

  const shutdown = (signal: string) => {
    stderr.write(`[soak] received ${signal}, exiting\n`)
    clearInterval(timer)
    exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

void main()
