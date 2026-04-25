#!/usr/bin/env -S node --experimental-strip-types
/**
 * Cross-validator stateRoot audit
 *
 * Polls all configured validators' eth_getBlockByNumber for both `latest`
 * and a stable historical block. Flags when validators commit different
 * stateRoots at the same height — the symptom that took 95 min to be
 * noticed in the 2026-04-25 incident.
 *
 * Two modes:
 *   - One-shot (default): single audit, exit 0 = consistent, 1 = divergent
 *   - Daemon (`--watch`): poll every `--interval` seconds, log on each
 *     check, exit only on SIGINT
 *
 * Usage:
 *   node --experimental-strip-types scripts/state-divergence-audit.ts \
 *     --rpcs http://node-1:18780,http://node-2:18780,http://node-3:18780 \
 *     [--watch] [--interval 30] [--quiet]
 *
 * Designed to be wired into Prometheus alertmanager later. The exit-code
 * + last-line-of-output convention is also CI/cron friendly.
 */

export interface CliArgs {
  rpcs: string[]
  watch: boolean
  intervalSec: number
  quiet: boolean
  historyDepth: number  // also audit a fixed depth back (default 100 blocks)
}

export interface ValidatorView {
  rpc: string
  height: bigint
  latestStateRoot: string
  historicalHeight: bigint
  historicalStateRoot: string
  errored?: string
}

// Injection point for tests / future Prometheus integration.
export type RpcFn = (url: string, method: string, params?: unknown[]) => Promise<unknown>

const ANSI = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    rpcs: [],
    watch: false,
    intervalSec: 30,
    quiet: false,
    historyDepth: 100,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--rpcs" && i + 1 < argv.length) {
      args.rpcs = argv[++i].split(",").map((x) => x.trim()).filter(Boolean)
    } else if (a === "--watch") {
      args.watch = true
    } else if (a === "--interval" && i + 1 < argv.length) {
      args.intervalSec = Math.max(5, Number(argv[++i]))
    } else if (a === "--history" && i + 1 < argv.length) {
      args.historyDepth = Math.max(0, Number(argv[++i]))
    } else if (a === "--quiet") {
      args.quiet = true
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: state-divergence-audit.ts --rpcs <url1,url2,...> [--watch] [--interval N] [--history N] [--quiet]`)
      process.exit(0)
    } else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`)
      process.exit(2)
    }
  }
  if (args.rpcs.length === 0) {
    // Default to env var or testnet sensible default
    const fromEnv = process.env.COC_AUDIT_RPCS
    if (fromEnv) {
      args.rpcs = fromEnv.split(",").map((x) => x.trim()).filter(Boolean)
    } else {
      args.rpcs = [
        "http://127.0.0.1:28780",
        "http://127.0.0.1:28782",
        "http://127.0.0.1:28784",
      ]
    }
  }
  if (args.rpcs.length < 2) {
    console.error("need at least 2 RPC endpoints to compare")
    process.exit(2)
  }
  return args
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctrl.signal,
    })
    const json = (await r.json()) as { result?: unknown; error?: { message: string } }
    if (json.error) throw new Error(`${method}: ${json.error.message}`)
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

export async function probeValidator(
  rpcUrl: string,
  historyDepth: number,
  rpcFn: RpcFn = rpc,
): Promise<ValidatorView> {
  const view: ValidatorView = {
    rpc: rpcUrl,
    height: 0n,
    latestStateRoot: "",
    historicalHeight: 0n,
    historicalStateRoot: "",
  }
  try {
    const latestHex = (await rpcFn(rpcUrl, "eth_blockNumber")) as string
    view.height = BigInt(latestHex)
    const latest = (await rpcFn(rpcUrl, "eth_getBlockByNumber", [latestHex, false])) as { stateRoot?: string }
    view.latestStateRoot = String(latest?.stateRoot ?? "0x")
    if (historyDepth > 0 && view.height > BigInt(historyDepth)) {
      view.historicalHeight = view.height - BigInt(historyDepth)
      const histHex = "0x" + view.historicalHeight.toString(16)
      const hist = (await rpcFn(rpcUrl, "eth_getBlockByNumber", [histHex, false])) as { stateRoot?: string }
      view.historicalStateRoot = String(hist?.stateRoot ?? "0x")
    }
  } catch (err) {
    view.errored = err instanceof Error ? err.message : String(err)
  }
  return view
}

export interface AuditResult {
  consistent: boolean
  views: ValidatorView[]
  // For each (height tag, stateRoot), which RPCs reported it
  latestGroups: Map<string, string[]>
  historicalGroups: Map<string, string[]>
  // Notes about errored / unreachable peers
  errors: Array<{ rpc: string; error: string }>
}

export function group(views: ValidatorView[], pick: "latest" | "historical"): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const v of views) {
    if (v.errored) continue
    const root = pick === "latest" ? v.latestStateRoot : v.historicalStateRoot
    if (!root) continue
    const peers = out.get(root) ?? []
    peers.push(v.rpc)
    out.set(root, peers)
  }
  return out
}

export async function audit(args: CliArgs, rpcFn: RpcFn = rpc): Promise<AuditResult> {
  // Probe all validators in parallel — slow ones don't block fast ones.
  const views = await Promise.all(args.rpcs.map((url) => probeValidator(url, args.historyDepth, rpcFn)))
  const errors = views.filter((v) => v.errored).map((v) => ({ rpc: v.rpc, error: v.errored ?? "unknown" }))
  const latestGroups = group(views, "latest")
  const historicalGroups = group(views, "historical")
  // Consistent iff: all reachable validators report the same stateRoot
  // for `latest` AND the same for the historical pin.
  const consistent =
    latestGroups.size === 1 &&
    (historicalGroups.size <= 1 || args.historyDepth === 0)
  return { consistent, views, latestGroups, historicalGroups, errors }
}

export function formatReport(args: CliArgs, r: AuditResult): string {
  const lines: string[] = []
  const stamp = new Date().toISOString()
  lines.push(`[${stamp}] state-divergence-audit (${args.rpcs.length} validators)`)
  for (const v of r.views) {
    if (v.errored) {
      lines.push(`  ${ANSI.yellow}⚠${ANSI.reset} ${v.rpc} — ERROR: ${v.errored}`)
      continue
    }
    const histPart = args.historyDepth > 0
      ? `   bn=${v.historicalHeight} stateRoot=${v.historicalStateRoot}`
      : ""
    lines.push(`     ${v.rpc}`)
    lines.push(`       latest:    bn=${v.height} stateRoot=${v.latestStateRoot}`)
    if (histPart) lines.push(`       historical:${histPart}`)
  }
  if (r.consistent) {
    lines.push(`${ANSI.green}${ANSI.bold}✅ CONSISTENT${ANSI.reset} — all validators agree`)
  } else {
    lines.push(`${ANSI.red}${ANSI.bold}❌ DIVERGENCE DETECTED${ANSI.reset}`)
    if (r.latestGroups.size > 1) {
      lines.push(`  latest stateRoot has ${r.latestGroups.size} distinct values:`)
      for (const [root, peers] of r.latestGroups) {
        lines.push(`    ${root.slice(0, 18)}…   (peers: ${peers.join(", ")})`)
      }
    }
    if (args.historyDepth > 0 && r.historicalGroups.size > 1) {
      lines.push(`  historical stateRoot (depth ${args.historyDepth}) has ${r.historicalGroups.size} distinct values:`)
      for (const [root, peers] of r.historicalGroups) {
        lines.push(`    ${root.slice(0, 18)}…   (peers: ${peers.join(", ")})`)
      }
    }
  }
  if (r.errors.length > 0) {
    lines.push(`  ${ANSI.yellow}${r.errors.length} validator(s) unreachable${ANSI.reset}`)
  }
  return lines.join("\n")
}

async function runOnce(args: CliArgs): Promise<number> {
  const result = await audit(args)
  if (!args.quiet || !result.consistent) {
    console.log(formatReport(args, result))
  }
  // Return code:
  //   0 = consistent (all reachable validators agree)
  //   1 = divergence detected
  //   2 = couldn't reach enough peers to render a verdict
  if (result.errors.length === args.rpcs.length) return 2
  return result.consistent ? 0 : 1
}

async function watchLoop(args: CliArgs): Promise<void> {
  console.log(`watching every ${args.intervalSec}s — Ctrl-C to stop`)
  let lastVerdict: boolean | null = null
  let stop = false
  process.on("SIGINT", () => {
    console.log("\nstopping watch loop...")
    stop = true
  })
  while (!stop) {
    const result = await audit(args)
    const stamp = new Date().toISOString()
    if (result.consistent) {
      if (!args.quiet || lastVerdict === false) {
        const reachable = args.rpcs.length - result.errors.length
        const heights = [...new Set(result.views.filter((v) => !v.errored).map((v) => v.height.toString()))]
        console.log(`[${stamp}] ✅ consistent (${reachable}/${args.rpcs.length} reachable; height(s) ${heights.join(",")})`)
      }
    } else {
      // Always print on transitions or on each fail
      console.log(formatReport(args, result))
    }
    lastVerdict = result.consistent
    if (stop) break
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000))
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  if (args.watch) {
    await watchLoop(args)
    return
  }
  const code = await runOnce(args)
  process.exit(code)
}

// Run main() only when invoked directly (not when imported by tests).
const argv1 = process.argv[1] ?? ""
const thisFile = new URL(import.meta.url).pathname
if (argv1.endsWith("state-divergence-audit.ts") || argv1 === thisFile) {
  void main().catch((err) => {
    console.error("audit error:", err)
    process.exit(3)
  })
}
