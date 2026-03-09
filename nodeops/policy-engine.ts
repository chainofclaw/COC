import type { NodeHealthSnapshot, NodeOpsPolicy, NodeOpsPolicyV2, PolicyRule } from "./policy-types.ts"
import { evaluateCondition } from "./expression-eval.ts"

export const NodeOpsActionType = {
  RestartProcess: "RESTART_PROCESS",
  ReconnectPeers: "RECONNECT_PEERS",
  SwitchTransport: "SWITCH_TRANSPORT",
  RaiseAlert: "RAISE_ALERT",
  TightenRateLimit: "TIGHTEN_RATE_LIMIT",
  ScheduleKeyRotation: "SCHEDULE_KEY_ROTATION",
} as const

export type NodeOpsActionType = (typeof NodeOpsActionType)[keyof typeof NodeOpsActionType]

export interface NodeOpsAction {
  type: NodeOpsActionType
  reason: string
  params?: Record<string, unknown>
}

export interface NodeOpsEngineState {
  lastRestartAtMs?: bigint
  lastKeyRotationAtMs?: bigint
}

export class NodeOpsPolicyEngine {
  private readonly policy: NodeOpsPolicy

  constructor(policy: NodeOpsPolicy) {
    this.policy = policy
  }

  evaluate(snapshot: NodeHealthSnapshot, state: NodeOpsEngineState): NodeOpsAction[] {
    const actions: NodeOpsAction[] = []

    if (!snapshot.processUp && this.policy.restartOnProcessDown) {
      const canRestart =
        state.lastRestartAtMs === undefined ||
        snapshot.nowMs - state.lastRestartAtMs >= BigInt(this.policy.restartCooldownMs)

      if (canRestart) {
        actions.push({ type: NodeOpsActionType.RestartProcess, reason: "process down" })
      } else {
        actions.push({ type: NodeOpsActionType.RaiseAlert, reason: "process down but restart cooldown active" })
      }
    }

    if (snapshot.peerCount < this.policy.thresholds.minPeerCount && this.policy.reconnectOnPeerDrop) {
      actions.push({
        type: NodeOpsActionType.ReconnectPeers,
        reason: "peer count low",
        params: { targetPeerCount: this.policy.peerReconnectTarget },
      })
    }

    if (
      snapshot.p95LatencyMs > this.policy.latencySwitchThresholdMs &&
      this.policy.switchTransportOnHighLatency
    ) {
      actions.push({ type: NodeOpsActionType.SwitchTransport, reason: "latency too high", params: { prefer: "quic" } })
    }

    if (snapshot.diskPct >= this.policy.thresholds.diskPct) {
      actions.push({ type: NodeOpsActionType.RaiseAlert, reason: "disk near full" })
    }

    if (snapshot.cpuPct > this.policy.thresholds.cpuPct || snapshot.memPct > this.policy.thresholds.memPct) {
      const tuned = Math.max(1, Math.floor(this.policy.rpcRateLimitRps * 0.8))
      actions.push({
        type: NodeOpsActionType.TightenRateLimit,
        reason: "resource pressure",
        params: { rpcRateLimitRps: tuned },
      })
    }

    if (shouldRotateKeys(snapshot.nowMs, state.lastKeyRotationAtMs, this.policy.keyRotateDays)) {
      actions.push({ type: NodeOpsActionType.ScheduleKeyRotation, reason: "rotation window reached" })
    }

    // Evaluate DSL rules (V2 policy extension)
    const v2Policy = this.policy as NodeOpsPolicyV2
    if (v2Policy.rules && v2Policy.rules.length > 0) {
      const vars: Record<string, number> = {
        cpuPct: snapshot.cpuPct,
        memPct: snapshot.memPct,
        diskPct: snapshot.diskPct,
        p95LatencyMs: snapshot.p95LatencyMs,
        peerCount: snapshot.peerCount,
      }
      for (const rule of v2Policy.rules) {
        try {
          if (evaluateCondition(rule.condition, vars)) {
            const actionType = mapRuleAction(rule.action)
            actions.push({ type: actionType, reason: `rule:${rule.name}`, params: { cooldownMs: rule.cooldownMs } })
          }
        } catch {
          // Skip rules with invalid expressions
        }
      }
    }

    return actions
  }
}

function mapRuleAction(action: PolicyRule["action"]): NodeOpsActionType {
  switch (action) {
    case "restart": return NodeOpsActionType.RestartProcess
    case "alert": return NodeOpsActionType.RaiseAlert
    case "reconnect": return NodeOpsActionType.ReconnectPeers
    case "switchTransport": return NodeOpsActionType.SwitchTransport
    case "custom": return NodeOpsActionType.RaiseAlert
  }
}

function shouldRotateKeys(nowMs: bigint, lastRotationAtMs: bigint | undefined, rotateDays: number): boolean {
  if (rotateDays <= 0) return false
  if (lastRotationAtMs === undefined) return true
  const interval = BigInt(rotateDays) * 24n * 60n * 60n * 1000n
  return nowMs - lastRotationAtMs >= interval
}
