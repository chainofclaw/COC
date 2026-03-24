// State restorer: orchestrates the full recovery pipeline
// [resolve chain] -> [download files] -> [verify integrity] -> [report]

import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { RecoveryResult, SnapshotManifest } from "../types.ts"
import { resolveChainFromCid } from "./chain-resolver.ts"
import { applyManifestChain } from "./downloader.ts"
import { verifyManifestMerkleRoot, verifyRestoredFiles } from "./integrity-checker.ts"

interface Logger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

/**
 * Full recovery from a known manifest CID.
 * Resolves the incremental chain, downloads all files, and verifies integrity.
 */
export async function restoreFromManifestCid(
  manifestCid: string,
  targetDir: string,
  ipfs: IpfsClient,
  privateKeyOrPassword: string,
  isPassword: boolean,
  logger: Logger,
): Promise<RecoveryResult> {
  logger.info(`Starting recovery from manifest CID: ${manifestCid}`)

  // 1. Resolve the backup chain (follows parentCid links)
  logger.info("Resolving backup chain...")
  const chain = await resolveChainFromCid(manifestCid, ipfs)
  logger.info(`Resolved chain: ${chain.length} manifests (${chain[0]?.parentCid === null ? "starts with full backup" : "WARNING: no full backup root"})`)

  // 2. Verify each manifest's internal Merkle root
  for (let i = 0; i < chain.length; i++) {
    const manifest = chain[i]
    if (!verifyManifestMerkleRoot(manifest)) {
      throw new Error(
        `Manifest ${i} Merkle root verification failed — possible tampering`,
      )
    }
    logger.info(`Manifest ${i}: Merkle root verified (${manifest.fileCount} files)`)
  }

  // 3. Download and apply the chain
  logger.info("Downloading files from IPFS...")
  const downloadResult = await applyManifestChain(
    chain,
    targetDir,
    ipfs,
    privateKeyOrPassword,
    isPassword,
  )

  if (downloadResult.errors.length > 0) {
    for (const err of downloadResult.errors) {
      logger.error(`Failed to restore ${err.path}: ${err.error}`)
    }
  }

  // 4. Verify restored files against the latest manifest
  logger.info("Verifying restored file integrity...")
  const latestManifest = chain[chain.length - 1]
  const integrityResult = await verifyRestoredFiles(latestManifest, targetDir)

  if (!integrityResult.valid) {
    const invalidFiles = integrityResult.fileResults.filter((f) => !f.valid)
    logger.warn(
      `Integrity check: ${invalidFiles.length} files failed verification`,
    )
    for (const f of invalidFiles) {
      logger.warn(`  ${f.path}: expected ${f.expectedHash}, got ${f.actualHash}`)
    }
  } else {
    logger.info("All files verified successfully")
  }

  return {
    filesRestored: downloadResult.filesWritten,
    totalBytes: downloadResult.totalBytes,
    backupsApplied: chain.length,
    merkleVerified: integrityResult.valid,
  }
}

/**
 * Recovery from on-chain data (requires known agentId).
 * Looks up the latest backup CID on-chain, then delegates to restoreFromManifestCid.
 */
export async function restoreFromChain(
  agentId: string,
  targetDir: string,
  soul: SoulClient,
  ipfs: IpfsClient,
  privateKeyOrPassword: string,
  isPassword: boolean,
  logger: Logger,
): Promise<RecoveryResult> {
  logger.info(`Looking up soul on-chain: ${agentId}`)

  const soulInfo = await soul.getSoul(agentId)
  if (!soulInfo.active) {
    throw new Error(`Soul ${agentId} is not active or not found`)
  }

  if (soulInfo.backupCount === 0) {
    throw new Error(`Soul ${agentId} has no backups`)
  }

  logger.info(
    `Found soul: ${soulInfo.backupCount} backups, ` +
    `last backup at ${new Date(soulInfo.lastBackupAt * 1000).toISOString()}`,
  )

  // The latest snapshot CID is stored as bytes32 (keccak256 of CID string)
  // We need the actual CID string to retrieve from IPFS
  // This requires maintaining a local CID mapping or using MFS paths
  throw new Error(
    "On-chain recovery requires a CID registry mapping bytes32 -> IPFS CID. " +
    "Use restoreFromManifestCid() with the known manifest CID instead. " +
    "The manifest CID can be found in the backup logs or MFS at /soul-backups/",
  )
}
