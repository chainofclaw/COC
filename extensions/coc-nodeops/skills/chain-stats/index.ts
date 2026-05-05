/**
 * `openclaw coc chain-stats` — Phase L.2b skill skeleton.
 *
 * Contract: docs/openclaw-skills-v0.2-spec.md § 2.
 * Outputs TPS / gas / per-validator activity over a sliding window.
 *
 * Sampling strategy: pull `coc_chainStats` for the rollup, then sample
 * the head + window-start blocks via `eth_getBlockByNumber` to compute
 * the window stats locally. We deliberately do NOT pull every block —
 * a 24h window is ~28k blocks at 3 s, fetching all of them across the
 * RPC would dwarf the cost of the skill's other work.
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

const SKILL_NAME = "coc.chain-stats"

interface SkillFlags {
  window: string
  validators: boolean
}

interface ChainStatsOutput {
  schemaVersion: string
  skill: string
  node: { id: string; rpc: string }
  window: { startMs: number; endMs: number; durationMs: number }
  blocks: {
    count: number
    tipHeight: number
    minBaseFeeWei: string
    maxBaseFeeWei: string
    avgGasUsed: number
  }
  tps: { total: number; median: number }
  validators?: Array<{ id: string; blocksProposed: number; missedRotations: number }>
}

const HELP = `openclaw coc chain-stats — TPS + gas + validator activity over a window.

Usage:
  openclaw coc chain-stats [--node <id>] [--window <duration>] [--validators] [--json]

Options:
  --node <id>          Node selector (default: default)
  --rpc <url>          Bypass config; query this URL directly
  --auth-token <token> Admin RPC token
  --window <duration>  e.g. 5m, 1h, 24h (default 5m)
  --validators         Include per-validator block production
  --timeout-ms <n>     RPC timeout (default 5000)
  --json               Structured output
  --help               Print this and exit (exit code 2)
`

function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s)
  if (!m) throw new UsageError(`bad --window: ${s} (expected e.g. 5m, 1h, 24h)`)
  const n = Number(m[1])
  const unit = m[2]
  switch (unit) {
    case "s": return n * 1000
    case "m": return n * 60_000
    case "h": return n * 3_600_000
    case "d": return n * 86_400_000
    default: throw new UsageError(`bad --window unit: ${unit}`)
  }
}

function parseSkillArgs(rest: string[]): SkillFlags {
  const out: SkillFlags = { window: "5m", validators: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    switch (a) {
      case "--window":
        out.window = rest[++i] ?? ""
        if (!out.window) throw new UsageError("--window requires a value")
        break
      case "--validators":
        out.validators = true
        break
      default:
        throw new UsageError(`unknown flag: ${a}`)
    }
  }
  return out
}

interface BlockSample {
  number: bigint
  timestamp: bigint
  txCount: number
  gasUsed: bigint
  baseFeePerGas: bigint
  proposer?: string
}

async function fetchBlock(
  rpc: string,
  authToken: string | undefined,
  timeoutMs: number,
  height: bigint,
): Promise<BlockSample | null> {
  const r = await rpcCall<{
    number: string
    timestamp: string
    transactions: unknown[]
    gasUsed: string
    baseFeePerGas?: string
    miner?: string
  }>(rpc, "eth_getBlockByNumber", [`0x${height.toString(16)}`, false], authToken, timeoutMs)
  if (!r) return null
  return {
    number: BigInt(r.number),
    timestamp: BigInt(r.timestamp),
    txCount: r.transactions.length,
    gasUsed: BigInt(r.gasUsed),
    baseFeePerGas: BigInt(r.baseFeePerGas ?? "0x0"),
    proposer: r.miner,
  }
}

async function collect(
  rpc: string,
  authToken: string | undefined,
  timeoutMs: number,
  windowMs: number,
  includeValidators: boolean,
): Promise<ChainStatsOutput> {
  const tipHex = await rpcCall<string>(rpc, "eth_blockNumber", [], authToken, timeoutMs)
  const tipHeight = BigInt(tipHex)

  // Sample tip + walk back until window threshold or genesis. Cap sample
  // count to keep skill latency bounded — large windows fall back to
  // estimation off the head and tail samples.
  const HARD_SAMPLE_CAP = 200
  const tip = await fetchBlock(rpc, authToken, timeoutMs, tipHeight)
  if (!tip) throw new Error(`tip block ${tipHeight} not found`)
  const cutoffMs = Number(tip.timestamp) * 1000 - windowMs

  const samples: BlockSample[] = [tip]
  const proposerCount = new Map<string, number>()
  let cursor = tipHeight - 1n
  while (samples.length < HARD_SAMPLE_CAP && cursor >= 0n) {
    const b = await fetchBlock(rpc, authToken, timeoutMs, cursor)
    if (!b) break
    if (Number(b.timestamp) * 1000 < cutoffMs) break
    samples.push(b)
    cursor--
  }

  let totalTx = 0
  let minBaseFee = samples[0].baseFeePerGas
  let maxBaseFee = samples[0].baseFeePerGas
  let totalGas = 0n
  for (const s of samples) {
    totalTx += s.txCount
    if (s.baseFeePerGas < minBaseFee) minBaseFee = s.baseFeePerGas
    if (s.baseFeePerGas > maxBaseFee) maxBaseFee = s.baseFeePerGas
    totalGas += s.gasUsed
    if (s.proposer) {
      proposerCount.set(s.proposer, (proposerCount.get(s.proposer) ?? 0) + 1)
    }
  }
  const startMs = Number(samples[samples.length - 1].timestamp) * 1000
  const endMs = Number(samples[0].timestamp) * 1000
  const durationMs = Math.max(1, endMs - startMs)
  const tpsTotal = totalTx > 0 ? (totalTx / (durationMs / 1000)) : 0
  // Median of per-block TPS — robust to outlier blocks.
  const perBlockTps = samples.map((s) => s.txCount / 3) // 3 s/block heuristic
  perBlockTps.sort((a, b) => a - b)
  const median = perBlockTps.length === 0 ? 0
    : perBlockTps.length % 2 === 1
      ? perBlockTps[(perBlockTps.length - 1) / 2]
      : (perBlockTps[perBlockTps.length / 2 - 1] + perBlockTps[perBlockTps.length / 2]) / 2

  const info = await rpcCall<{ nodeId?: string }>(rpc, "coc_nodeInfo", [], authToken, timeoutMs)

  const out: ChainStatsOutput = {
    schemaVersion: SCHEMA_VERSION,
    skill: SKILL_NAME,
    node: { id: info.nodeId ?? "<unknown>", rpc },
    window: { startMs, endMs, durationMs },
    blocks: {
      count: samples.length,
      tipHeight: Number(tipHeight),
      minBaseFeeWei: minBaseFee.toString(),
      maxBaseFeeWei: maxBaseFee.toString(),
      avgGasUsed: samples.length > 0 ? Number(totalGas / BigInt(samples.length)) : 0,
    },
    tps: {
      total: Number(tpsTotal.toFixed(3)),
      median: Number(median.toFixed(3)),
    },
  }
  if (includeValidators) {
    out.validators = Array.from(proposerCount.entries())
      .map(([id, blocksProposed]) => ({
        id,
        blocksProposed,
        // missedRotations needs validator-set + rotation-formula access; the
        // skeleton leaves it 0 and the L.3 follow-up will compute it from
        // expectedProposer over the window.
        missedRotations: 0,
      }))
      .sort((a, b) => b.blocksProposed - a.blocksProposed)
  }
  return out
}

function renderHuman(out: ChainStatsOutput): string {
  const lines = [
    `Chain stats — ${out.node.id} (${out.node.rpc})`,
    `  window:        ${(out.window.durationMs / 1000).toFixed(0)} s (${out.blocks.count} samples)`,
    `  tip height:    ${out.blocks.tipHeight}`,
    `  TPS total:     ${out.tps.total}`,
    `  TPS median:    ${out.tps.median}`,
    `  baseFee min:   ${out.blocks.minBaseFeeWei} wei`,
    `  baseFee max:   ${out.blocks.maxBaseFeeWei} wei`,
    `  avg gasUsed:   ${out.blocks.avgGasUsed}`,
  ]
  if (out.validators) {
    lines.push("  validators:")
    for (const v of out.validators) {
      lines.push(`    ${v.id}: ${v.blocksProposed} blocks (missed rotations: ${v.missedRotations})`)
    }
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
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
    throw err
  }

  let target
  try {
    target = resolveNode(base)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
    throw err
  }

  try {
    const windowMs = parseDuration(skill.window)
    const out = await collect(target.rpc, target.authToken, base.timeoutMs, windowMs, skill.validators)
    if (base.json) stdout.write(JSON.stringify(out, null, 2) + "\n")
    else stdout.write(renderHuman(out))
    return 0
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
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
