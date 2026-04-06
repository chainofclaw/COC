// Carrier communication protocol types
// Defines the HTTP API contract between resurrection initiators and carrier nodes

export interface ResurrectionNotification {
  requestId: string
  agentId: string
  carrierId: string
  trigger: "owner-key" | "guardian-vote"
  latestManifestCidHash: string
  encryptionMode: "none" | "privateKey" | "password"
  timestamp: string
  signature: string // HMAC-SHA256 signed with resurrection key
}

export interface CarrierAck {
  accepted: boolean
  carrierId: string
  reason?: string
  estimatedRestoreTimeMs?: number
}

export interface PullResult {
  success: boolean
  filesRestored: number
  totalBytes: number
  merkleVerified: boolean
  error?: string
}

export interface CarrierHealthStatus {
  carrierId: string
  alive: boolean
  cpuUsagePercent: number
  memoryUsedMB: number
  storageFreeMB: number
  activeResurrections: number
  maxConcurrent: number
  uptime: number
}

export type CarrierState =
  | "idle"
  | "monitoring"
  | "resurrection_initiated"  // request validated, offline verified
  | "carrier_confirmed"       // confirmCarrier() sent
  | "waiting_readiness"       // polling getResurrectionReadiness()
  | "downloading_backup"      // autoRestore() running
  | "restoring_state"         // files written to disk
  | "spawning_agent"          // child process launched
  | "health_checking"         // polling health endpoint
  | "resurrection_complete"   // completeResurrection() + heartbeat sent
  | "failed"

export interface CarrierResurrectionRecord {
  requestId: string
  agentId: string
  state: CarrierState
  startedAt: number
  completedAt: number | null
  error: string | null
  filesRestored: number
  agentPid: number | null
}

// HTTP endpoint paths for the carrier protocol
export const CARRIER_ENDPOINTS = {
  NOTIFY: "/carrier/resurrect",
  HEALTH: "/carrier/health",
  STATUS: "/carrier/status",
} as const
