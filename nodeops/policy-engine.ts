import type { NodeHealthSnapshot, NodeOpsPolicy } from "./policy-types.ts"

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

    return actions
  }
}

function shouldRotateKeys(nowMs: bigint, lastRotationAtMs: bigint | undefined, rotateDays: number): boolean {
  if (rotateDays <= 0) return false
  if (lastRotationAtMs === undefined) return true
  const interval = BigInt(rotateDays) * 24n * 60n * 60n * 1000n
  return nowMs - lastRotationAtMs >= interval
}
