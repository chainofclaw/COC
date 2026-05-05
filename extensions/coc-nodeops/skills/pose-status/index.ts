/**
 * `openclaw coc pose-status` — Phase L.2 skill skeleton.
 *
 * Implements the contract from `docs/openclaw-skills-v0.2-spec.md` § 1.
 * Sister skills (`chain-stats`, `health`, `upgrade`) reuse the same
 * argument parser + JSON envelope pattern; do NOT diverge them without
 * also bumping the spec's schemaVersion.
 */

import { argv, exit, env, stderr, stdout } from "node:process"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SCHEMA_VERSION = "0.2"
const SKILL_NAME = "coc.pose-status"
const DEFAULT_TIMEOUT_MS = 5000

interface CliFlags {
  node: string
  rpc?: string
  authToken?: string
  json: boolean
  watch: boolean
  epoch?: number
  timeoutMs: number
  help: boolean
}

interface NodeRecord {
  rpc: string
  authToken?: string
}

interface NodeOpsConfig {
  defaultNode: string
  nodes: Record<string, NodeRecord>
}

interface PoseStatusOutput {
  schemaVersion: string
  skill: string
  node: { id: string; rpc: string; version: string }
  epoch: { current: number; queriedEpoch: number; startedAtMs: number; ageMs: number }
  metrics: {
    challengesIssued: number
    receiptsVerified: number
    receiptsPending: number
    rewardPoolWei: string
    slashTotalWei: string
  }
  health: { ok: boolean; issues: string[] }
}

interface ErrorEnvelope {
  error: { code: string; message: string; skill: string; remediation?: string }
}

const HELP = `openclaw coc pose-status — report PoSe epoch + node metrics.

Usage:
  openclaw coc pose-status [--node <id>] [--epoch <n>] [--json] [--watch]

Options:
  --node <id>          Node selector from ~/.coc/nodeops.json (default: default)
  --rpc <url>          Bypass config; query this URL directly
  --auth-token <token> Admin RPC token (also reads COC_RPC_AUTH_TOKEN)
  --epoch <n>          Query a past epoch instead of current
  --timeout-ms <n>     RPC timeout (default 5000)
  --json               Structured JSON output
  --watch              Re-run every 5s until Ctrl-C (conflicts with --json)
  --help               Print this and exit (exit code 2)
`

class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError" }
}

export function parseArgs(args: string[]): CliFlags {
  const out: CliFlags = {
    node: "default",
    json: false,
    watch: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case "--help": case "-h": out.help = true; break
      case "--node": out.node = args[++i]; break
      case "--rpc": out.rpc = args[++i]; break
      case "--auth-token": out.authToken = args[++i]; break
      case "--epoch": out.epoch = Number(args[++i]); break
      case "--timeout-ms": out.timeoutMs = Number(args[++i]); break
      case "--json": out.json = true; break
      case "--watch": out.watch = true; break
      default:
        throw new UsageError(`unknown flag: ${a}`)
    }
  }
  if (out.watch && out.json) {
    throw new UsageError("--watch and --json are mutually exclusive")
  }
  return out
}

function loadConfig(): NodeOpsConfig | null {
  const path = join(homedir(), ".coc", "nodeops.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as NodeOpsConfig
  } catch {
    return null
  }
}

function resolveNode(flags: CliFlags): { rpc: string; authToken?: string } {
  if (flags.rpc) return { rpc: flags.rpc, authToken: flags.authToken ?? env.COC_RPC_AUTH_TOKEN }
  const cfg = loadConfig()
  if (!cfg) {
    return { rpc: "http://127.0.0.1:18780", authToken: flags.authToken ?? env.COC_RPC_AUTH_TOKEN }
  }
  const id = flags.node === "default" ? cfg.defaultNode : flags.node
  const rec = cfg.nodes[id]
  if (!rec) {
    stderr.write(`node "${id}" not in ~/.coc/nodeops.json\n`)
    exit(2)
  }
  return { rpc: rec.rpc, authToken: flags.authToken ?? rec.authToken ?? env.COC_RPC_AUTH_TOKEN }
}

async function rpcCall<T = unknown>(
  rpc: string,
  method: string,
  params: unknown[],
  authToken: string | undefined,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json() as { result?: T; error?: { code: number; message: string } }
    if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`)
    return json.result as T
  } finally {
    clearTimeout(timer)
  }
}

async function collectStatus(
  rpc: string,
  authToken: string | undefined,
  timeoutMs: number,
  queriedEpoch: number | undefined,
): Promise<PoseStatusOutput> {
  // Fan out independent reads in parallel; chain stats is the tip-of-tree
  // call, the others enrich it. Each is best-effort with no retries — the
  // caller relies on exit codes for partial-failure detection.
  const [info, pose] = await Promise.all([
    rpcCall<{ clientVersion: string; nodeId: string; blockHeight: string }>(
      rpc, "coc_nodeInfo", [], authToken, timeoutMs,
    ),
    rpcCall<{
      currentEpoch: number
      epochStartedAtMs: number
      challengesIssued: number
      receiptsVerified: number
      receiptsPending: number
      rewardPoolWei: string
      slashTotalWei: string
    }>(rpc, "coc_poseStatus", queriedEpoch ? [queriedEpoch] : [], authToken, timeoutMs),
  ])

  const ageMs = Date.now() - pose.epochStartedAtMs
  const issues: string[] = []
  // Light-weight sanity checks; comprehensive health belongs to `coc health`.
  if (pose.receiptsPending > pose.challengesIssued) issues.push("pending exceeds issued — clock skew suspected")
  if (ageMs < 0) issues.push("epochStartedAtMs in the future — node clock skew")

  return {
    schemaVersion: SCHEMA_VERSION,
    skill: SKILL_NAME,
    node: { id: info.nodeId ?? "<unknown>", rpc, version: info.clientVersion ?? "<unknown>" },
    epoch: {
      current: pose.currentEpoch,
      queriedEpoch: queriedEpoch ?? pose.currentEpoch,
      startedAtMs: pose.epochStartedAtMs,
      ageMs,
    },
    metrics: {
      challengesIssued: pose.challengesIssued,
      receiptsVerified: pose.receiptsVerified,
      receiptsPending: pose.receiptsPending,
      rewardPoolWei: pose.rewardPoolWei,
      slashTotalWei: pose.slashTotalWei,
    },
    health: { ok: issues.length === 0, issues },
  }
}

function renderHuman(out: PoseStatusOutput): string {
  const lines = [
    `PoSe status — ${out.node.id} (${out.node.rpc})`,
    `  client:        ${out.node.version}`,
    `  epoch:         ${out.epoch.queriedEpoch}${out.epoch.queriedEpoch === out.epoch.current ? " (current)" : ""}`,
    `  age:           ${(out.epoch.ageMs / 1000).toFixed(1)} s`,
    `  challenges:    ${out.metrics.challengesIssued}`,
    `  verified:      ${out.metrics.receiptsVerified}`,
    `  pending:       ${out.metrics.receiptsPending}`,
    `  reward pool:   ${out.metrics.rewardPoolWei} wei`,
    `  slash total:   ${out.metrics.slashTotalWei} wei`,
    `  health:        ${out.health.ok ? "ok" : "degraded — " + out.health.issues.join("; ")}`,
  ]
  return lines.join("\n") + "\n"
}

function emitError(envelope: ErrorEnvelope, json: boolean): void {
  if (json) {
    stdout.write(JSON.stringify(envelope) + "\n")
  } else {
    stderr.write(`${envelope.error.code}: ${envelope.error.message}\n`)
    if (envelope.error.remediation) stderr.write(`  → ${envelope.error.remediation}\n`)
  }
}

async function runOnce(flags: CliFlags): Promise<number> {
  const { rpc, authToken } = resolveNode(flags)
  try {
    const out = await collectStatus(rpc, authToken, flags.timeoutMs, flags.epoch)
    if (flags.json) stdout.write(JSON.stringify(out, null, 2) + "\n")
    else stdout.write(renderHuman(out))
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const name = err instanceof Error ? err.name : ""
    // AbortError covers the AbortController timeout path; "fetch failed"
    // covers DNS / TCP refusal; "HTTP" covers our own non-2xx wrap.
    const isTimeout = name === "AbortError"
      || msg.includes("aborted")
      || msg.includes("fetch failed")
      || msg.includes("HTTP")
      || msg.includes("ECONNREFUSED")
    if (isTimeout) {
      emitError({
        error: {
          code: "POSE_RPC_TIMEOUT",
          message: msg,
          skill: SKILL_NAME,
          remediation: "increase --timeout-ms or check node health",
        },
      }, flags.json)
      return 3
    }
    if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) {
      emitError({
        error: { code: "POSE_AUTH", message: msg, skill: SKILL_NAME, remediation: "check --auth-token / COC_RPC_AUTH_TOKEN" },
      }, flags.json)
      return 4
    }
    emitError({
      error: { code: "POSE_INTERNAL", message: msg, skill: SKILL_NAME },
    }, flags.json)
    return 1
  }
}

export async function main(args: string[] = argv.slice(2)): Promise<number> {
  let flags: CliFlags
  try {
    flags = parseArgs(args)
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${err.message}\n`)
      return 2
    }
    throw err
  }
  if (flags.help) {
    stdout.write(HELP)
    return 2
  }
  if (!flags.watch) return runOnce(flags)

  // --watch loop: re-run every 5s until Ctrl-C. Emits to terminal directly;
  // the `--json` conflict is enforced in parseArgs.
  let exitCode = 0
  const tick = async (): Promise<void> => {
    stdout.write("\x1b[2J\x1b[H") // clear + cursor home
    exitCode = await runOnce(flags)
  }
  await tick()
  const handle = setInterval(() => { void tick() }, 5000)
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(handle)
      resolve()
    })
  })
  return exitCode
}

// Allow direct CLI invocation (`node --experimental-strip-types index.ts`)
if (import.meta.url === `file://${argv[1]}` || argv[1]?.endsWith("index.ts")) {
  main().then((code) => exit(code)).catch((err) => {
    stderr.write(`unhandled: ${err}\n`)
    exit(1)
  })
}
