// Shared types for COC Soul Backup extension

export type { CocBackupConfig } from "./config-schema.ts"

export interface FileState {
  relativePath: string
  absolutePath: string
  hash: string          // SHA-256 hex
  sizeBytes: number
  mtimeMs: number
  encrypted: boolean
  category: FileCategory
}

export type FileCategory = "identity" | "memory" | "chat" | "config" | "workspace"

export interface ChangeSet {
  added: FileState[]
  modified: FileState[]
  deleted: string[]      // relative paths
  unchanged: FileState[]
}

export interface SnapshotManifest {
  version: 1
  agentId: string        // hex
  timestamp: string      // ISO 8601
  parentCid: string | null
  files: Record<string, ManifestFileEntry>
  merkleRoot: string     // hex
  totalBytes: number
  fileCount: number
}

export interface ManifestFileEntry {
  cid: string            // IPFS CID (base58 or base32)
  hash: string           // SHA-256 hex
  sizeBytes: number
  encrypted: boolean
  category: FileCategory
}

export interface BackupResult {
  manifestCid: string
  dataMerkleRoot: string
  fileCount: number
  totalBytes: number
  backupType: 0 | 1      // 0=full, 1=incremental
  parentManifestCid: string | null
  txHash: string | null   // on-chain anchor tx hash
  anchoredAt: number | null
}

export interface BackupReceipt {
  status: "completed" | "skipped" | "registration_required"
  reason: string | null
  heartbeatStatus: "sent" | "not_configured" | "failed" | "not_attempted"
  heartbeatError: string | null
  backup: BackupResult | null
}

export interface RecoveryResult {
  filesRestored: number
  totalBytes: number
  backupsApplied: number  // number of manifests applied (full + incremental chain)
  merkleVerified: boolean
  requestedManifestCid: string
  resolvedAgentId: string | null
  anchorCheckAttempted: boolean
  anchorCheckPassed: boolean
  anchorCheckReason: string | null
}

export interface SoulInfo {
  agentId: string
  owner: string
  identityCid: string
  latestSnapshotCid: string
  registeredAt: number
  lastBackupAt: number
  backupCount: number
  version: number
  active: boolean
}

export interface OnChainBackup {
  manifestCid: string
  dataMerkleRoot: string
  anchoredAt: number
  fileCount: number
  totalBytes: number
  backupType: number
  parentManifestCid: string
}

// Resurrection types

export interface ResurrectionConfig {
  resurrectionKeyHash: string  // bytes32
  maxOfflineDuration: number   // seconds
  lastHeartbeat: number        // unix timestamp
  configured: boolean
}

export interface CarrierInfo {
  carrierId: string            // bytes32
  owner: string                // address
  endpoint: string
  registeredAt: number         // unix timestamp
  cpuMillicores: number
  memoryMB: number
  storageMB: number
  available: boolean
  active: boolean
}

export interface ResurrectionResult {
  requestId: string
  agentId: string
  carrierId: string
  trigger: "owner-key" | "guardian-vote"
  filesRestored: number
  totalBytes: number
}

export interface ResurrectionRequestInfo {
  requestId: string
  agentId: string
  carrierId: string
  initiator: string
  initiatedAt: number
  approvalCount: number
  guardianSnapshot: number
  executed: boolean
  carrierConfirmed: boolean
  trigger: "owner-key" | "guardian-vote"
}

export interface ResurrectionReadiness {
  exists: boolean
  trigger: "owner-key" | "guardian-vote"
  approvalCount: number
  approvalThreshold: number
  carrierConfirmed: boolean
  offlineNow: boolean
  readyAt: number
  canComplete: boolean
}

export interface ResurrectionStartResult {
  txHash: string
  requestId: string
}

export type LifecycleState =
  | "unregistered"
  | "registered_no_backup"
  | "healthy"
  | "backup_overdue"
  | "ipfs_unreachable"
  | "restore_ready"
  | "restore_blocked"
  | "resurrection_unconfigured"
  | "offline"
  | "resurrection_pending"
  | "attention_required"

export interface RecommendedAction {
  id: string
  label: string
  description: string
  command: string | null
}

export interface BackupPersistenceState {
  version: 1
  latestAgentId: string | null
  lastManifestCid: string | null
  incrementalCount: number
  lastBackupAt: number | null
  lastFullBackupAt: number | null
  latestRecoveryPackagePath: string | null
  pendingResurrectionRequestId: string | null
  pendingCarrierId: string | null
}

export interface BackupRecoveryPackage {
  version: 1
  agentId: string
  latestManifestCid: string
  anchoredAt: number | null
  txHash: string | null
  dataMerkleRoot: string
  backupType: "full" | "incremental"
  encryptionMode: "none" | "privateKey" | "password"
  requiresPassword: boolean
  recommendedRestoreCommand: string
}

export interface DoctorReport {
  state: LifecycleState
  generatedAt: string
  agentId: string | null
  local: {
    dataDir: string
    dataDirExists: boolean
    statePath: string
    recoveryPackagePath: string
  }
  ipfs: {
    reachable: boolean
  }
  chain: {
    registered: boolean
    owner: string | null
    backupCount: number
    lastBackupAt: number | null
    backupOverdue: boolean
  }
  restore: {
    available: boolean
    blocked: boolean
    reason: string | null
    latestManifestCid: string | null
    encryptionMode: "none" | "privateKey" | "password" | "unknown"
    requiresPassword: boolean
    packagePresent: boolean
  }
  resurrection: {
    configured: boolean
    offline: boolean
    pendingRequestId: string | null
    request: ResurrectionRequestInfo | null
    readiness: ResurrectionReadiness | null
  }
  actions: RecommendedAction[]
}
