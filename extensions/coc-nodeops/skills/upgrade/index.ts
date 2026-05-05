/**
 * `openclaw coc upgrade` — Phase L.2d skill skeleton (dry-run only).
 *
 * Contract: docs/openclaw-skills-v0.2-spec.md § 4.
 *
 * Phase L.2 ships dry-run only. `--apply` returns exit 1 with a
 * NotImplemented error envelope; the actual `docker pull` /
 * `docker compose up -d --no-deps <node>` orchestration is deferred to
 * Phase L.3 because it needs:
 *   - validator-rotation safety bar (don't recreate a validator that
 *     proposes the next 3 heights — would induce stuck-round per J2.2)
 *   - post-upgrade health verification loop
 *   - rollback path if health fails to recover
 * which together justify a separate implementation pass.
 */

import { argv, env, stdout } from "node:process"
import {
  classifyError,
  emitError,
  parseBaseFlags,
  resolveNode,
  rpcCall,
  SCHEMA_VERSION,
  UsageError,
} from "../lib/cli-base.ts"

const SKILL_NAME = "coc.upgrade"

interface SkillFlags {
  target: string
  apply: boolean
  yes: boolean
}

interface UpgradeAction {
  step: string
  skipped: boolean
}

interface UpgradePlan {
  schemaVersion: string
  skill: string
  node: { id: string; rpc: string }
  current: { image: string; version: string }
  target: { image: string; digest: string }
  actions: UpgradeAction[]
  applied: boolean
}

const HELP = `openclaw coc upgrade — node binary/image upgrade (dry-run skeleton).

Usage:
  openclaw coc upgrade [--node <id>] [--target <tag>] [--apply] [--yes] [--json]

Options:
  --node <id>          Node selector (default: default)
  --rpc <url>          Bypass config; query this URL directly
  --auth-token <token> Admin RPC token
  --target <tag>       Docker image tag (default: latest)
  --apply              Actually perform the upgrade (NOT IMPLEMENTED in v0.2 skeleton)
  --yes                Skip confirmation prompt (required with --apply)
  --timeout-ms <n>     RPC timeout (default 5000)
  --json               Structured output
  --help               Print this and exit (exit code 2)
`

function parseSkillArgs(rest: string[]): SkillFlags {
  const out: SkillFlags = { target: "latest", apply: false, yes: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    switch (a) {
      case "--target":
        out.target = rest[++i] ?? ""
        if (!out.target) throw new UsageError("--target requires a value")
        break
      case "--apply": out.apply = true; break
      case "--yes": out.yes = true; break
      default: throw new UsageError(`unknown flag: ${a}`)
    }
  }
  return out
}

async function buildPlan(
  rpc: string,
  authToken: string | undefined,
  timeoutMs: number,
  target: string,
): Promise<UpgradePlan> {
  // Reach the node to capture current version + identity. If the node
  // is down we still produce a plan (with placeholder current image)
  // because operators commonly invoke `upgrade --target` precisely when
  // the node is degraded.
  let currentVersion = "<unknown>"
  let nodeId = "<unknown>"
  try {
    const info = await rpcCall<{ clientVersion: string; nodeId: string }>(
      rpc, "coc_nodeInfo", [], authToken, timeoutMs,
    )
    currentVersion = info.clientVersion ?? currentVersion
    nodeId = info.nodeId ?? nodeId
  } catch {
    // best-effort; plan can still be useful as a dry-run preview
  }

  // Phase L.2 doesn't query the actual docker image digest — it would
  // require docker-CLI integration on the operator's host. Leave the
  // current.image / target.digest fields as informative placeholders;
  // the L.3 follow-up will fill them via `docker inspect`.
  const targetImage = `ghcr.io/chainofclaw/coc-node:${target}`

  return {
    schemaVersion: SCHEMA_VERSION,
    skill: SKILL_NAME,
    node: { id: nodeId, rpc },
    current: { image: "<requires docker inspect>", version: currentVersion },
    target: { image: targetImage, digest: "<resolved at apply-time>" },
    actions: [
      { step: `docker pull ${targetImage}`, skipped: false },
      { step: "docker compose up -d --no-deps <node>", skipped: false },
      { step: "wait for coc.health.ok ≤ 60s", skipped: false },
      { step: "rollback on failure", skipped: false },
    ],
    applied: false,
  }
}

function renderHuman(plan: UpgradePlan): string {
  const lines = [
    `Upgrade plan — ${plan.node.id} (${plan.node.rpc})`,
    `  current:  ${plan.current.version}`,
    `  target:   ${plan.target.image}`,
    "  actions:",
    ...plan.actions.map((a) => `    - ${a.step}${a.skipped ? " [SKIPPED]" : ""}`),
    `  applied:  ${plan.applied ? "yes" : "no (dry-run)"}`,
  ]
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

  // Apply gate: confirmation + skill scope.
  if (skill.apply) {
    if (!skill.yes && env.COC_OPS_CONFIRM !== "1") {
      const msg = "--apply requires --yes or COC_OPS_CONFIRM=1 (refuses to upgrade silently)"
      emitError({ error: { code: "UPGRADE_NEEDS_CONFIRM", message: msg, skill: SKILL_NAME } }, base.json)
      return 1
    }
    // L.2 skeleton scope: dry-run only. Refuse apply explicitly so
    // operators don't think the no-op succeeded.
    emitError({
      error: {
        code: "UPGRADE_NOT_IMPLEMENTED",
        message: "--apply is not implemented in the v0.2 skeleton; ship via the L.3 follow-up",
        skill: SKILL_NAME,
        remediation: "remove --apply to run dry-run, or wait for L.3",
      },
    }, base.json)
    return 1
  }

  try {
    const plan = await buildPlan(target.rpc, target.authToken, base.timeoutMs, skill.target)
    if (base.json) stdout.write(JSON.stringify(plan, null, 2) + "\n")
    else stdout.write(renderHuman(plan))
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
