// Chain resolver: reconstructs the backup chain from on-chain history
// Walks parentManifestCid links from latest incremental back to last full backup

import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { SnapshotManifest, OnChainBackup } from "../types.ts"
import type { CidResolver } from "./cid-resolver.ts"
import { cidToBytes32 } from "../backup/anchor.ts"

const ZERO_BYTES32 = "0x" + "0".repeat(64)

export interface BackupChainEntry {
  onChain: OnChainBackup
  manifest: SnapshotManifest
  manifestCid: string
}

/**
 * Resolve the full backup chain for an agentId.
 * Returns entries ordered from oldest (full backup) to newest (latest incremental).
 */
export async function resolveBackupChain(
  agentId: string,
  soul: SoulClient,
  ipfs: IpfsClient,
  cidResolver?: CidResolver,
): Promise<BackupChainEntry[]> {
  const backupCount = await soul.getBackupCount(agentId)
  if (backupCount === 0) {
    return []
  }

  // Fetch all backups from chain (paginated)
  const allBackups: OnChainBackup[] = []
  const pageSize = 50
  for (let offset = 0; offset < backupCount; offset += pageSize) {
    const page = await soul.getBackupHistory(agentId, offset, pageSize)
    allBackups.push(...page)
  }

  // Build CID -> backup index for parent lookup
  const byManifestCid = new Map<string, { index: number; backup: OnChainBackup }>()
  for (let i = 0; i < allBackups.length; i++) {
    byManifestCid.set(allBackups[i].manifestCid, { index: i, backup: allBackups[i] })
  }

  // Start from latest backup, walk back to find the full backup root
  const latest = allBackups[allBackups.length - 1]
  const chain: OnChainBackup[] = [latest]

  let current = latest
  while (current.backupType === 1 && current.parentManifestCid !== ZERO_BYTES32) {
    const parent = byManifestCid.get(current.parentManifestCid)
    if (!parent) {
      throw new Error(
        `Broken backup chain: parent ${current.parentManifestCid} not found on-chain`,
      )
    }
    chain.unshift(parent.backup)
    current = parent.backup
  }

  // Verify chain starts with a full backup
  if (chain[0].backupType !== 0) {
    throw new Error("Backup chain does not start with a full backup (type=0)")
  }

  // Resolve manifests from IPFS
  const result: BackupChainEntry[] = []
  for (const backup of chain) {
    // We need to find the original CID from the bytes32 hash
    // The manifest CID is stored as keccak256(CID string) on-chain
    // We need to download from IPFS using the actual CID
    // For now, we search through manifests
    const manifest = await findManifestByCidHash(backup.manifestCid, ipfs, cidResolver)
    result.push({
      onChain: backup,
      manifest,
      manifestCid: backup.manifestCid,
    })
  }

  return result
}

/**
 * Resolve a bytes32 CID hash back to the original IPFS CID and fetch the manifest.
 * Uses CidResolver's three-layer fallback (local index → MFS → on-chain).
 */
async function findManifestByCidHash(
  cidHash: string,
  ipfs: IpfsClient,
  cidResolver?: CidResolver,
): Promise<SnapshotManifest> {
  if (!cidResolver) {
    throw new Error(
      "Direct CID resolution from bytes32 hash requires a CID resolver. " +
      "Use restoreFromManifestCid() with the known CID instead, " +
      "or configure a CID resolver.",
    )
  }

  const cid = await cidResolver.resolve(cidHash)
  if (!cid) {
    throw new Error(
      `Cannot resolve CID for hash ${cidHash}. ` +
      "Check local index, MFS paths, or on-chain CidRegistry.",
    )
  }

  // Verify integrity
  const verified = cidToBytes32(cid)
  if (verified !== cidHash) {
    throw new Error(
      `CID integrity check failed: ${cid} hashes to ${verified}, expected ${cidHash}`,
    )
  }

  return ipfs.catManifest(cid)
}

/**
 * Resolve backup chain starting from a known manifest CID.
 * This is the primary recovery path — the user provides the latest manifest CID.
 */
export async function resolveChainFromCid(
  manifestCid: string,
  ipfs: IpfsClient,
): Promise<SnapshotManifest[]> {
  const chain: SnapshotManifest[] = []
  const visited = new Set<string>()
  let currentCid: string | null = manifestCid

  while (currentCid) {
    if (visited.has(currentCid)) {
      throw new Error(`Circular parentCid reference detected: ${currentCid}`)
    }
    visited.add(currentCid)
    const manifest = await ipfs.catManifest(currentCid)
    chain.unshift(manifest) // prepend: build oldest-first order
    currentCid = manifest.parentCid
  }

  return chain
}
