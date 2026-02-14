export interface NodeOpsThresholds {
  cpuPct: number
  memPct: number
  diskPct: number
  p95LatencyMs: number
  minPeerCount: number
}

export interface NodeOpsPolicy {
  profile: string
  monitoringPollMs: number
  thresholds: NodeOpsThresholds
  restartOnProcessDown: boolean
  restartCooldownMs: number
  reconnectOnPeerDrop: boolean
  peerReconnectTarget: number
  switchTransportOnHighLatency: boolean
  latencySwitchThresholdMs: number
  rpcRateLimitRps: number
  keyRotateDays: number
}

export interface NodeHealthSnapshot {
  nowMs: bigint
  processUp: boolean
  cpuPct: number
  memPct: number
  diskPct: number
  p95LatencyMs: number
  peerCount: number
}

export const DEFAULT_NODEOPS_POLICY: NodeOpsPolicy = {
  profile: "default",
  monitoringPollMs: 15000,
  thresholds: {
    cpuPct: 85,
    memPct: 85,
    diskPct: 90,
    p95LatencyMs: 2500,
    minPeerCount: 8,
  },
  restartOnProcessDown: true,
  restartCooldownMs: 120000,
  reconnectOnPeerDrop: true,
  peerReconnectTarget: 12,
  switchTransportOnHighLatency: true,
  latencySwitchThresholdMs: 3500,
  rpcRateLimitRps: 20,
  keyRotateDays: 30,
}
