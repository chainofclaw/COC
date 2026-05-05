#!/usr/bin/env node --experimental-strip-types
/**
 * Phase M2.3 — soak summarizer.
 *
 * Reads docs/soak-reports/raw/<runId>.jsonl and writes a markdown report
 * to docs/soak-reports/<runId>.md applying the Day-60-Gate verdict rules:
 *
 *   PASS iff:
 *     - height monotonic non-decreasing (with at most 1 brief restart drop tolerated)
 *     - 0 stall windows >= 120s (no height progress)
 *     - equivocations counter ends at 0
 *     - forkDepthMax <= 1 throughout
 *     - mean inter-block time <= 4s (computed from height delta / wall delta)
 *
 * Usage: node --experimental-strip-types scripts/soak/summarize.ts <runId>
 */

import { argv, exit, stderr, stdout } from "node:process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

interface Sample {
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

interface StallWindow {
  startTs: string
  endTs: string
  durationSecs: number
  heightAt: number
}

interface Verdict {
  pass: boolean
  reasons: string[]
}

function parseArgs(args: string[]): { runId: string } {
  if (args.length < 1 || args[0] === "--help" || args[0] === "-h") {
    stderr.write("usage: summarize.ts <runId>\n")
    exit(2)
  }
  return { runId: args[0] }
}

function loadSamples(jsonlPath: string): Sample[] {
  if (!existsSync(jsonlPath)) {
    stderr.write(`error: ${jsonlPath} not found\n`)
    exit(3)
  }
  const text = readFileSync(jsonlPath, "utf8")
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  const samples: Sample[] = []
  for (const line of lines) {
    try {
      samples.push(JSON.parse(line) as Sample)
    } catch (err) {
      stderr.write(`warn: skipping malformed line: ${line.slice(0, 80)}...\n`)
    }
  }
  return samples
}

function findStalls(samples: Sample[], thresholdSecs = 120): StallWindow[] {
  const stalls: StallWindow[] = []
  let stallStart: { ts: string; height: number } | null = null

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const cur = samples[i]
    if (cur.height === null || prev.height === null) continue
    if (cur.height === prev.height) {
      if (!stallStart) stallStart = { ts: prev.ts, height: prev.height }
    } else if (stallStart) {
      const dur = (Date.parse(prev.ts) - Date.parse(stallStart.ts)) / 1000
      if (dur >= thresholdSecs) {
        stalls.push({
          startTs: stallStart.ts,
          endTs: prev.ts,
          durationSecs: Math.round(dur),
          heightAt: stallStart.height,
        })
      }
      stallStart = null
    }
  }
  // Trailing stall if file ended mid-stall.
  if (stallStart && samples.length > 0) {
    const last = samples[samples.length - 1]
    const dur = (Date.parse(last.ts) - Date.parse(stallStart.ts)) / 1000
    if (dur >= thresholdSecs) {
      stalls.push({
        startTs: stallStart.ts,
        endTs: last.ts,
        durationSecs: Math.round(dur),
        heightAt: stallStart.height,
      })
    }
  }
  return stalls
}

function checkHeightMonotonic(samples: Sample[]): { ok: boolean; drops: number } {
  let drops = 0
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].height
    const cur = samples[i].height
    if (prev === null || cur === null) continue
    if (cur < prev) drops++
  }
  // Tolerate 1 restart-related drop.
  return { ok: drops <= 1, drops }
}

function meanBlockTime(samples: Sample[]): number | null {
  const valid = samples.filter((s) => s.height !== null)
  if (valid.length < 2) return null
  const first = valid[0]
  const last = valid[valid.length - 1]
  const heightDelta = (last.height as number) - (first.height as number)
  if (heightDelta <= 0) return null
  const wallDelta = (Date.parse(last.ts) - Date.parse(first.ts)) / 1000
  return wallDelta / heightDelta
}

function evaluateVerdict(samples: Sample[], stalls: StallWindow[]): Verdict {
  const reasons: string[] = []
  let pass = true

  const monotonic = checkHeightMonotonic(samples)
  if (!monotonic.ok) {
    pass = false
    reasons.push(`height non-monotonic: ${monotonic.drops} drops detected`)
  }

  if (stalls.length > 0) {
    pass = false
    reasons.push(`${stalls.length} stall window(s) >= 120s`)
  }

  const last = samples[samples.length - 1]
  if (last && typeof last.equivocations === "number" && last.equivocations !== 0) {
    pass = false
    reasons.push(`equivocations counter = ${last.equivocations} (expected 0)`)
  }

  const maxFork = samples.reduce((m, s) => {
    const v = s.forkDepthMax
    return typeof v === "number" && v > m ? v : m
  }, 0)
  if (maxFork > 1) {
    pass = false
    reasons.push(`fork depth max = ${maxFork} (expected <= 1)`)
  }

  const mbt = meanBlockTime(samples)
  if (mbt === null) {
    pass = false
    reasons.push("could not compute mean block time (insufficient samples)")
  } else if (mbt > 4) {
    pass = false
    reasons.push(`mean block time = ${mbt.toFixed(2)}s (expected <= 4s)`)
  }

  if (pass) reasons.push("all gate criteria met")
  return { pass, reasons }
}

function fmtMarkdown(runId: string, samples: Sample[], stalls: StallWindow[], verdict: Verdict): string {
  const first = samples[0]
  const last = samples[samples.length - 1]
  const wallSecs = first && last ? (Date.parse(last.ts) - Date.parse(first.ts)) / 1000 : 0
  const heightDelta = first && last && typeof first.height === "number" && typeof last.height === "number"
    ? last.height - first.height
    : 0
  const mbt = meanBlockTime(samples)
  const maxFork = samples.reduce((m, s) => (typeof s.forkDepthMax === "number" && s.forkDepthMax > m ? s.forkDepthMax : m), 0)
  const finalEquivs = last && typeof last.equivocations === "number" ? last.equivocations : "n/a"

  const lines: string[] = []
  lines.push(`# Soak Report — ${runId}`)
  lines.push("")
  lines.push(`**Verdict:** ${verdict.pass ? "✅ PASS" : "❌ FAIL"}`)
  lines.push("")
  lines.push("## Run Metadata")
  lines.push("")
  lines.push(`| Field | Value |`)
  lines.push(`|---|---|`)
  lines.push(`| runId | \`${runId}\` |`)
  lines.push(`| samples | ${samples.length} |`)
  lines.push(`| start | ${first?.ts ?? "n/a"} |`)
  lines.push(`| end | ${last?.ts ?? "n/a"} |`)
  lines.push(`| wall duration (s) | ${Math.round(wallSecs)} |`)
  lines.push(`| height start → end | ${first?.height ?? "n/a"} → ${last?.height ?? "n/a"} |`)
  lines.push(`| blocks produced | ${heightDelta} |`)
  lines.push(`| mean block time (s) | ${mbt?.toFixed(2) ?? "n/a"} |`)
  lines.push(`| max fork depth | ${maxFork} |`)
  lines.push(`| final equivocations | ${finalEquivs} |`)
  lines.push("")

  lines.push("## Stall Windows (≥120s)")
  lines.push("")
  if (stalls.length === 0) {
    lines.push("None detected.")
  } else {
    lines.push(`| start | end | duration (s) | height |`)
    lines.push(`|---|---|---|---|`)
    for (const s of stalls) {
      lines.push(`| ${s.startTs} | ${s.endTs} | ${s.durationSecs} | ${s.heightAt} |`)
    }
  }
  lines.push("")

  lines.push("## Verdict Detail")
  lines.push("")
  for (const r of verdict.reasons) lines.push(`- ${r}`)
  lines.push("")

  lines.push("## Sampling Notes")
  lines.push("")
  lines.push("- Source: Prometheus `/metrics` (one HTTP poll per sample, 60s default cadence).")
  lines.push("- `blockTimeP95` is approximated from histogram buckets (smallest `le` ≥ 0.95 cumulative).")
  lines.push("- Height drops up to 1 are tolerated (validator restart during run).")
  lines.push("")
  lines.push("---")
  lines.push("")
  lines.push("Generated by `scripts/soak/summarize.ts`.")
  return lines.join("\n") + "\n"
}

function main(): void {
  const { runId } = parseArgs(argv.slice(2))
  const jsonlPath = `docs/soak-reports/raw/${runId}.jsonl`
  const mdPath = `docs/soak-reports/${runId}.md`

  const samples = loadSamples(jsonlPath)
  if (samples.length === 0) {
    stderr.write(`error: no samples in ${jsonlPath}\n`)
    exit(3)
  }

  const stalls = findStalls(samples)
  const verdict = evaluateVerdict(samples, stalls)
  const md = fmtMarkdown(runId, samples, stalls, verdict)

  writeFileSync(mdPath, md)
  stdout.write(md)
  stderr.write(`[summarize] wrote ${mdPath} verdict=${verdict.pass ? "PASS" : "FAIL"}\n`)

  exit(verdict.pass ? 0 : 1)
}

main()
