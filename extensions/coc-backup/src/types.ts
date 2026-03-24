// Shared types for COC Soul Backup extension

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
}

export interface RecoveryResult {
  filesRestored: number
  totalBytes: number
  backupsApplied: number  // number of manifests applied (full + incremental chain)
  merkleVerified: boolean
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
