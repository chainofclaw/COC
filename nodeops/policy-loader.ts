import { readFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { readdirSync } from "node:fs"
import type { NodeOpsPolicy, NodeOpsThresholds } from "./policy-types.ts"
import { DEFAULT_NODEOPS_POLICY } from "./policy-types.ts"

interface RawPolicyYaml {
  version?: number
  profile?: string
  deploy?: Record<string, unknown>
  monitoring?: {
    poll_interval_ms?: number
    thresholds?: {
      cpu_pct?: number
      mem_pct?: number
      disk_pct?: number
      p95_latency_ms?: number
      min_peer_count?: number
    }
  }
  self_heal?: {
    restart_on_process_down?: boolean
    restart_cooldown_ms?: number
    reconnect_on_peer_drop?: boolean
    peer_reconnect_target?: number
    switch_transport_on_high_latency?: boolean
    latency_switch_threshold_ms?: number
  }
  security?: {
    rpc_rate_limit_rps?: number
    [key: string]: unknown
  }
  audit?: Record<string, unknown>
  key_management?: {
    rotate_every_days?: number
    [key: string]: unknown
  }
}

export function loadPolicyFromFile(filePath: string): NodeOpsPolicy {
  const absolutePath = resolve(filePath)
  const content = readFileSync(absolutePath, "utf-8")
  return parsePolicyYaml(content)
}

export function loadPolicyFromEnv(): NodeOpsPolicy {
  const policyPath = process.env.COC_NODEOPS_POLICY_PATH
  if (!policyPath) {
    return { ...DEFAULT_NODEOPS_POLICY }
  }
  return loadPolicyFromFile(policyPath)
}

export function loadAllPolicies(dir: string): Map<string, NodeOpsPolicy> {
  const policies = new Map<string, NodeOpsPolicy>()
  const absoluteDir = resolve(dir)
  const entries = readdirSync(absoluteDir)
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue
    const filePath = join(absoluteDir, entry)
    const policy = loadPolicyFromFile(filePath)
    const name = entry.replace(/\.(yaml|yml)$/, "")
    policies.set(name, policy)
  }
  return policies
}

export function parsePolicyYaml(content: string): NodeOpsPolicy {
  const raw = parseSimpleYaml(content) as RawPolicyYaml
  return mapToPolicy(raw)
}

function mapToPolicy(raw: RawPolicyYaml): NodeOpsPolicy {
  const defaults = DEFAULT_NODEOPS_POLICY
  const thresholds: NodeOpsThresholds = {
    cpuPct: raw.monitoring?.thresholds?.cpu_pct ?? defaults.thresholds.cpuPct,
    memPct: raw.monitoring?.thresholds?.mem_pct ?? defaults.thresholds.memPct,
    diskPct: raw.monitoring?.thresholds?.disk_pct ?? defaults.thresholds.diskPct,
    p95LatencyMs: raw.monitoring?.thresholds?.p95_latency_ms ?? defaults.thresholds.p95LatencyMs,
    minPeerCount: raw.monitoring?.thresholds?.min_peer_count ?? defaults.thresholds.minPeerCount,
  }

  return {
    profile: raw.profile ?? defaults.profile,
    monitoringPollMs: raw.monitoring?.poll_interval_ms ?? defaults.monitoringPollMs,
    thresholds,
    restartOnProcessDown: raw.self_heal?.restart_on_process_down ?? defaults.restartOnProcessDown,
    restartCooldownMs: raw.self_heal?.restart_cooldown_ms ?? defaults.restartCooldownMs,
    reconnectOnPeerDrop: raw.self_heal?.reconnect_on_peer_drop ?? defaults.reconnectOnPeerDrop,
    peerReconnectTarget: raw.self_heal?.peer_reconnect_target ?? defaults.peerReconnectTarget,
    switchTransportOnHighLatency: raw.self_heal?.switch_transport_on_high_latency ?? defaults.switchTransportOnHighLatency,
    latencySwitchThresholdMs: raw.self_heal?.latency_switch_threshold_ms ?? defaults.latencySwitchThresholdMs,
    rpcRateLimitRps: raw.security?.rpc_rate_limit_rps ?? defaults.rpcRateLimitRps,
    keyRotateDays: raw.key_management?.rotate_every_days ?? defaults.keyRotateDays,
  }
}

// Minimal YAML parser for policy files (handles nested objects, arrays, scalars)
function parseSimpleYaml(content: string): Record<string, unknown> {
  const lines = content.split("\n")
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }]

  for (const rawLine of lines) {
    const commentIdx = rawLine.indexOf("#")
    const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine
    if (line.trim().length === 0) continue

    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    // Array item
    if (trimmed.startsWith("- ")) {
      const value = parseScalar(trimmed.slice(2).trim())
      const parent = findParent(stack, indent)
      const parentObj = parent.obj
      const lastKey = getLastKey(parentObj)
      if (lastKey !== null) {
        const existing = parentObj[lastKey]
        if (Array.isArray(existing)) {
          existing.push(value)
        } else {
          parentObj[lastKey] = [value]
        }
      }
      continue
    }

    const colonIdx = trimmed.indexOf(":")
    if (colonIdx < 0) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const valueStr = trimmed.slice(colonIdx + 1).trim()

    // Pop stack to correct parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]

    if (valueStr.length === 0) {
      // Nested object
      const child: Record<string, unknown> = {}
      parent.obj[key] = child
      stack.push({ indent, obj: child })
    } else {
      parent.obj[key] = parseScalar(valueStr)
    }
  }

  return root
}

function findParent(
  stack: Array<{ indent: number; obj: Record<string, unknown> }>,
  indent: number,
): { indent: number; obj: Record<string, unknown> } {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].indent < indent) return stack[i]
  }
  return stack[0]
}

function getLastKey(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj)
  return keys.length > 0 ? keys[keys.length - 1] : null
}

function parseScalar(value: string): string | number | boolean {
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null" || value === "~") return ""
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)
  // Strip quotes
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}
