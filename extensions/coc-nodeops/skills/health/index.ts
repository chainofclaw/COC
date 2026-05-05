/**
 * `openclaw coc health` — Phase L.2c skill skeleton.
 *
 * Contract: docs/openclaw-skills-v0.2-spec.md § 3.
 * Aggregates 5 checks: rpc.reachable, bft.progress, sync.gap,
 * mempool.size, validator.rotation. Each emits an `ok` / `warn` / `crit`
 * level. With `--strict`, `warn` is treated as failure (exit 1).
 *
 * Skeleton scope: rpc.reachable + sync.gap + mempool.size are computed
 * from existing RPC; bft.progress + validator.rotation are placeholder
 * `ok` levels until the L.3 follow-up wires them to coc_diagnostics +
 * validator-activity. The L.1 spec freezes the JSON envelope so the
 * placeholder fields are fixed in shape now.
 */

import { argv, stdout } from "node:process"
import {
  classifyError,
  emitError,
  parseBaseFlags,
  resolveNode,
  rpcCall,
  SCHEMA_VERSION,
  UsageError,
} from "../lib/cli-base.ts"

const SKILL_NAME = "coc.health"

interface SkillFlags {
  strict: boolean
}

interface CheckResult {
  name: string
  level: "ok" | "warn" | "crit"
  detail: string
}

interface HealthOutput {
  schemaVersion: string
  skill: string
  node: { id: string; rpc: string }
  ok: boolean
  checks: CheckResult[]
}

const HELP = `openclaw coc health — aggregated health diagnostic.

Usage:
  openclaw coc health [--node <id>] [--strict] [--json]

Options:
  --node <id>          Node selector (default: default)
  --rpc <url>          Bypass config; query this URL directly
  --auth-token <token> Admin RPC token
  --strict             Treat WARN-level findings as failure (exit 1)
  --timeout-ms <n>     RPC timeout (default 5000)
  --json               Structured output
  --help               Print this and exit (exit code 2)
`

function parseSkillArgs(rest: string[]): SkillFlags {
  const out: SkillFlags = { strict: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    switch (a) {
      case "--strict": out.strict = true; break
      default: throw new UsageError(`unknown flag: ${a}`)
    }
  }
  return out
}

async function checkRpcReachable(
  rpc: string, authToken: string | undefined, timeoutMs: number,
): Promise<CheckResult> {
  const start = Date.now()
  try {
    await rpcCall<{ clientVersion: string }>(rpc, "coc_nodeInfo", [], authToken, timeoutMs)
    const elapsed = Date.now() - start
    return { name: "rpc.reachable", level: "ok", detail: `responded in ${elapsed}ms` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { name: "rpc.reachable", level: "crit", detail: msg }
  }
}

async function checkBftProgress(
  rpc: string, authToken: string | undefined, timeoutMs: number,
): Promise<CheckResult> {
  // Skeleton: treat presence of a recent block as progress proxy.
  // L.3 follow-up: use coc_chainStats which exposes lastFinalizedAtMs.
  try {
    const tipHex = await rpcCall<string>(rpc, "eth_blockNumber", [], authToken, timeoutMs)
    const blockHex = await rpcCall<{ timestamp: string }>(
      rpc, "eth_getBlockByNumber", [tipHex, false], authToken, timeoutMs,
    )
    const ageSec = Math.floor(Date.now() / 1000) - Number(BigInt(blockHex.timestamp))
    if (ageSec > 60) return { name: "bft.progress", level: "warn", detail: `last block ${ageSec}s ago` }
    if (ageSec > 300) return { name: "bft.progress", level: "crit", detail: `last block ${ageSec}s ago — likely stalled` }
    return { name: "bft.progress", level: "ok", detail: `last block ${ageSec}s ago` }
  } catch (err) {
    return { name: "bft.progress", level: "crit", detail: String(err instanceof Error ? err.message : err) }
  }
}

async function checkSyncGap(
  rpc: string, authToken: string | undefined, timeoutMs: number,
): Promise<CheckResult> {
  // Skeleton: compares local tip against highestPeerHeight from
  // coc_diagnostics. If diagnostics aren't available, treat as ok.
  try {
    const diag = await rpcCall<{ syncProgress?: { highestPeerHeight: string; localHeight: string } } | null>(
      rpc, "coc_diagnostics", [], authToken, timeoutMs,
    )
    if (!diag?.syncProgress) {
      return { name: "sync.gap", level: "ok", detail: "no sync diagnostics available — treating as healthy" }
    }
    const local = BigInt(diag.syncProgress.localHeight)
    const peer = BigInt(diag.syncProgress.highestPeerHeight)
    const gap = peer > local ? Number(peer - local) : 0
    if (gap > 100) return { name: "sync.gap", level: "crit", detail: `${gap} blocks behind` }
    if (gap > 5) return { name: "sync.gap", level: "warn", detail: `${gap} blocks behind` }
    return { name: "sync.gap", level: "ok", detail: gap === 0 ? "in sync" : `${gap} blocks behind tip` }
  } catch {
    return { name: "sync.gap", level: "ok", detail: "diagnostics call failed — treating as healthy" }
  }
}

async function checkMempool(
  rpc: string, authToken: string | undefined, timeoutMs: number,
): Promise<CheckResult> {
  try {
    const stats = await rpcCall<{ pending: number; queued: number }>(
      rpc, "txpool_status", [], authToken, timeoutMs,
    )
    const pending = stats.pending ?? 0
    const queued = stats.queued ?? 0
    const total = pending + queued
    if (total > 4500) return { name: "mempool.size", level: "warn", detail: `${total} / 5000 (near cap)` }
    return { name: "mempool.size", level: "ok", detail: `${total} (pending=${pending}, queued=${queued})` }
  } catch {
    return { name: "mempool.size", level: "ok", detail: "txpool_status not exposed — treating as healthy" }
  }
}

async function checkValidatorRotation(): Promise<CheckResult> {
  // Skeleton placeholder. L.3: use coc_validatorActivity over recent
  // window to count missed rotations for this node's id.
  return { name: "validator.rotation", level: "ok", detail: "skeleton — not yet implemented" }
}

async function collect(
  rpc: string, authToken: string | undefined, timeoutMs: number, nodeId: string,
): Promise<HealthOutput> {
  const checks = await Promise.all([
    checkRpcReachable(rpc, authToken, timeoutMs),
    checkBftProgress(rpc, authToken, timeoutMs),
    checkSyncGap(rpc, authToken, timeoutMs),
    checkMempool(rpc, authToken, timeoutMs),
    checkValidatorRotation(),
  ])
  const ok = checks.every((c) => c.level === "ok")
  return {
    schemaVersion: SCHEMA_VERSION,
    skill: SKILL_NAME,
    node: { id: nodeId, rpc },
    ok,
    checks,
  }
}

function renderHuman(out: HealthOutput): string {
  const lines = [
    `Health — ${out.node.id} (${out.node.rpc})`,
    `  overall:      ${out.ok ? "ok" : "degraded"}`,
  ]
  for (const c of out.checks) {
    const icon = c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"
    lines.push(`  ${icon} ${c.name.padEnd(20)}  ${c.level.padEnd(4)}  ${c.detail}`)
  }
  return lines.join("\n") + "\n"
}

export async function main(args: string[] = argv.slice(2)): Promise<number> {
  let base, skill
  try {
    base = parseBaseFlags(args)
    if (base.help) { stdout.write(HELP); return 2 }
    skill = parseSkillArgs(base.rest)
  } catch (err) {
    if (err instanceof UsageError) { process.stderr.write(`${err.message}\n`); return 2 }
    throw err
  }

  let target
  try { target = resolveNode(base) }
  catch (err) {
    if (err instanceof UsageError) { process.stderr.write(`${err.message}\n`); return 2 }
    throw err
  }

  try {
    // Resolve nodeId via reachable check; if RPC down, still emit a partial report.
    let nodeId = "<unknown>"
    try {
      const info = await rpcCall<{ nodeId: string }>(target.rpc, "coc_nodeInfo", [], target.authToken, base.timeoutMs)
      nodeId = info.nodeId ?? "<unknown>"
    } catch { /* best-effort */ }

    const out = await collect(target.rpc, target.authToken, base.timeoutMs, nodeId)
    if (base.json) stdout.write(JSON.stringify(out, null, 2) + "\n")
    else stdout.write(renderHuman(out))

    if (!out.ok) return 1
    if (skill.strict && out.checks.some((c) => c.level === "warn")) return 1
    return 0
  } catch (err) {
    const { code, envelope } = classifyError(err)
    emitError({ error: { ...envelope, skill: SKILL_NAME } }, base.json)
    return code
  }
}

if (import.meta.url === `file://${argv[1]}` || argv[1]?.endsWith("index.ts")) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`unhandled: ${err}\n`)
    process.exit(1)
  })
}
