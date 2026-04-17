// Recovery orchestrator: automated full recovery from agentId
// Combines CID resolution, state restoration, integrity verification, and agent notification

import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { CidResolver } from "./cid-resolver.ts"
import type { RecoveryResult } from "../types.ts"
import { restoreFromChain, restoreFromManifestCid } from "./state-restorer.ts"
import { writeRestoreMarker, notifyAgentRestart } from "./agent-restarter.ts"
import type { RestoreMarker } from "./agent-restarter.ts"
import { injectRecoveryContext } from "./context-injector.ts"

interface Logger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

export interface AutoRestoreOptions {
  agentId: string
  targetDir: string
  soul: SoulClient
  ipfs: IpfsClient
  cidResolver: CidResolver
  privateKeyOrPassword: string
  isPassword: boolean
  logger: Logger
  notifyAgent?: boolean
}

export interface AutoRestoreResult {
  recovery: RecoveryResult
  markerPath: string
  agentNotified: boolean
}

/**
 * Automated recovery from on-chain agentId.
 *
 * Flow:
 * 1. Look up soul on-chain → validate active + has backups
 * 2. Resolve latest backup CID via CidResolver (local → MFS → on-chain)
 * 3. Download, decrypt, and verify all files
 * 4. Write restore marker file
 * 5. Optionally notify running agent process
 */
export async function autoRestore(opts: AutoRestoreOptions): Promise<AutoRestoreResult> {
  const { agentId, targetDir, soul, ipfs, cidResolver, privateKeyOrPassword, isPassword, logger } = opts

  logger.info(`Auto-restore starting for agent ${agentId}`)

  // 1-3. Delegate to restoreFromChain (which uses cidResolver internally)
  const recovery = await restoreFromChain(
    agentId,
    targetDir,
    soul,
    ipfs,
    privateKeyOrPassword,
    isPassword,
    logger,
    cidResolver,
  )

  logger.info(
    `Recovery complete: ${recovery.filesRestored} files, ${recovery.totalBytes} bytes, ` +
    `${recovery.backupsApplied} manifests applied, merkle=${recovery.merkleVerified}`,
  )

  // 3b. Inject semantic recovery context (RECOVERY_CONTEXT.md)
  try {
    await injectRecoveryContext(targetDir, recovery, agentId)
    logger.info("Recovery context injected (RECOVERY_CONTEXT.md)")
  } catch (error) {
    logger.warn(`Recovery context injection failed (non-fatal): ${String(error)}`)
  }

  // 4. Write restore marker
  const marker: RestoreMarker = {
    version: 1,
    restoredAt: new Date().toISOString(),
    manifestCid: recovery.requestedManifestCid,
    agentId,
    filesRestored: recovery.filesRestored,
    totalBytes: recovery.totalBytes,
    backupsApplied: recovery.backupsApplied,
    merkleVerified: recovery.merkleVerified,
  }
  const markerPath = await writeRestoreMarker(targetDir, marker)
  logger.info(`Restore marker written: ${markerPath}`)

  // 5. Notify agent (optional)
  let agentNotified = false
  if (opts.notifyAgent !== false) {
    try {
      await notifyAgentRestart(targetDir, logger)
      agentNotified = true
    } catch (error) {
      logger.warn(`Agent notification failed (non-fatal): ${String(error)}`)
    }
  }

  return { recovery, markerPath, agentNotified }
}

/**
 * Restore from a known manifest CID (bypass on-chain lookup).
 * Useful when the user provides the CID directly.
 */
export async function restoreFromCid(
  manifestCid: string,
  targetDir: string,
  ipfs: IpfsClient,
  privateKeyOrPassword: string,
  isPassword: boolean,
  logger: Logger,
  soul?: SoulClient,
): Promise<AutoRestoreResult> {
  const recovery = await restoreFromManifestCid(
    manifestCid,
    targetDir,
    ipfs,
    privateKeyOrPassword,
    isPassword,
    logger,
    soul,
  )

  // Inject semantic recovery context
  try {
    await injectRecoveryContext(targetDir, recovery, recovery.resolvedAgentId ?? "unknown")
  } catch {
    // Non-fatal
  }

  const marker: RestoreMarker = {
    version: 1,
    restoredAt: new Date().toISOString(),
    manifestCid,
    agentId: recovery.resolvedAgentId ?? "unknown",
    filesRestored: recovery.filesRestored,
    totalBytes: recovery.totalBytes,
    backupsApplied: recovery.backupsApplied,
    merkleVerified: recovery.merkleVerified,
  }
  const markerPath = await writeRestoreMarker(targetDir, marker)

  let agentNotified = false
  try {
    await notifyAgentRestart(targetDir, logger)
    agentNotified = true
  } catch {
    // Non-fatal
  }

  return { recovery, markerPath, agentNotified }
}
