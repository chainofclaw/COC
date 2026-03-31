// On-chain backup anchoring: uploads manifest to IPFS and anchors CID on SoulRegistry

import { keccak256, toUtf8Bytes } from "ethers"
import type { IpfsClient } from "../ipfs-client.ts"
import type { SoulClient } from "../soul-client.ts"
import type { SnapshotManifest, BackupResult } from "../types.ts"

const ZERO_BYTES32 = "0x" + "0".repeat(64)

/** Convert an IPFS CID string to a bytes32 by hashing it */
export function cidToBytes32(cid: string): string {
  return keccak256(toUtf8Bytes(cid))
}

/**
 * Execute the full anchor flow:
 * 1. Upload manifest to IPFS
 * 2. Anchor manifest CID + Merkle root on-chain via SoulRegistry
 */
export async function anchorBackup(
  manifest: SnapshotManifest,
  ipfs: IpfsClient,
  soul: SoulClient,
): Promise<BackupResult> {
  // 1. Upload manifest to IPFS
  const manifestCid = await ipfs.addManifest(manifest)

  // 2. Convert CIDs to bytes32 for on-chain storage
  const manifestCidBytes32 = cidToBytes32(manifestCid)
  const dataMerkleRoot = manifest.merkleRoot
  const backupType = manifest.parentCid === null ? 0 : 1
  const parentManifestCid = manifest.parentCid
    ? cidToBytes32(manifest.parentCid)
    : ZERO_BYTES32

  // 3. Anchor on-chain
  const agentId = manifest.agentId
  const txHash = await soul.anchorBackup(
    agentId,
    manifestCidBytes32,
    dataMerkleRoot,
    manifest.fileCount,
    manifest.totalBytes,
    backupType as 0 | 1,
    parentManifestCid,
  )

  let anchoredAt: number | null = null
  try {
    const latest = await soul.getLatestBackup(agentId)
    if (latest.manifestCid === manifestCidBytes32) {
      anchoredAt = latest.anchoredAt
    }
  } catch {
    // Best-effort enrichment for recovery package metadata.
  }

  // 4. Organize in MFS for browsability
  try {
    const date = manifest.timestamp.slice(0, 10)
    const mfsDir = `/soul-backups/${manifest.agentId.slice(0, 10)}/${date}`
    await ipfs.mfsMkdir(mfsDir)
    await ipfs.mfsCp(manifestCid, `${mfsDir}/manifest.json`)
  } catch {
    // MFS organization is best-effort, don't fail the backup
  }

  return {
    manifestCid,
    dataMerkleRoot,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    backupType: backupType as 0 | 1,
    parentManifestCid: manifest.parentCid,
    txHash,
    anchoredAt,
  }
}
