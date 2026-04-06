// Resurrection flow: carrier-side state machine for automated agent recovery
//
// ROLE MODEL:
//   Guardian nodes: initiate + approve resurrections (external to this daemon)
//   Carrier daemon: detect pending request → confirm → wait for readiness →
//                   download backup → spawn agent → health check → complete
//
// The carrier daemon does NOT initiate or approve guardian-vote resurrections.
// Those are guardian responsibilities handled via CLI or guardian scripts.
//
// Flow: find_request → confirm_carrier → wait_readiness → download → spawn → health → complete

import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { CidResolver } from "../recovery/cid-resolver.ts"
import { autoRestore } from "../recovery/orchestrator.ts"
import { spawnAgent, waitForHealthy, stopAgent } from "./agent-spawner.ts"
import type { SpawnConfig } from "./agent-spawner.ts"
import type { CarrierState, CarrierResurrectionRecord } from "./protocol.ts"

interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface ResurrectionOverrides {
  spawnAgent?: (config: SpawnConfig, logger: Logger) => { pid: number; process: unknown }
  waitForHealthy?: (config: SpawnConfig, logger: Logger, shutdownSignal?: AbortSignal) => Promise<boolean>
  stopAgent?: (pid: number, logger: Logger) => void
}

export interface ResurrectionContext {
  /** The request ID of a pending resurrection targeting this carrier.
   *  Found via event indexing, CLI input, or config. */
  requestId: string
  agentId: string
  carrierId: string
  soul: SoulClient
  ipfs: IpfsClient
  cidResolver: CidResolver
  privateKeyOrPassword: string
  isPassword: boolean
  targetDir: string
  spawnConfig: SpawnConfig
  logger: Logger
  /** Max time (ms) to wait for guardian quorum + timelock. Default: 24h */
  readinessTimeoutMs?: number
  /** Polling interval (ms) for readiness checks. Default: 30s */
  readinessPollMs?: number
  overrides?: ResurrectionOverrides
  /** AbortSignal from daemon — when aborted, long-running waits should terminate */
  shutdownSignal?: AbortSignal
}

export interface ResurrectionResult {
  requestId: string
  agentId: string
  carrierId: string
  state: CarrierState
  filesRestored: number
  totalBytes: number
  agentPid: number | null
  error: string | null
}

const DEFAULT_READINESS_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h
const DEFAULT_READINESS_POLL_MS = 30_000 // 30s

/**
 * Execute the carrier-side resurrection flow for an offline agent.
 *
 * Prerequisites (handled externally by guardians):
 * - A guardian has called initiateGuardianResurrection(agentId, carrierId)
 * - Sufficient guardians have called approveResurrection(requestId)
 *
 * This function handles the carrier's responsibilities:
 * 1. Confirm carrier (on-chain)
 * 2. Wait for guardian quorum + timelock to be satisfied
 * 3. Download and restore backup from IPFS
 * 4. Spawn the agent process
 * 5. Health check
 * 6. Complete resurrection on-chain
 * 7. Send initial heartbeat
 */
export async function executeResurrectionFlow(
  ctx: ResurrectionContext,
): Promise<ResurrectionResult> {
  const record: CarrierResurrectionRecord = {
    requestId: ctx.requestId,
    agentId: ctx.agentId,
    state: "monitoring",
    startedAt: Date.now(),
    completedAt: null,
    error: null,
    filesRestored: 0,
    agentPid: null,
  }

  try {
    // Step 1: Verify agent is offline
    record.state = "resurrection_initiated"
    ctx.logger.info(`[resurrection] Verifying ${ctx.agentId} is offline...`)

    const isOffline = await ctx.soul.isOffline(ctx.agentId)
    if (!isOffline) {
      throw new Error(`Agent ${ctx.agentId} is not offline — aborting resurrection`)
    }

    // Step 2: Verify the request exists and targets this carrier
    const request = await ctx.soul.getResurrectionRequest(ctx.requestId)
    if (request.agentId !== ctx.agentId) {
      throw new Error(`Request ${ctx.requestId} is for agent ${request.agentId}, not ${ctx.agentId}`)
    }
    if (request.carrierId !== ctx.carrierId) {
      throw new Error(`Request ${ctx.requestId} targets carrier ${request.carrierId}, not ${ctx.carrierId}`)
    }
    if (request.executed) {
      throw new Error(`Request ${ctx.requestId} has already been executed`)
    }

    ctx.logger.info(`[resurrection] Request ${ctx.requestId} validated (trigger: ${request.trigger})`)

    // Step 3: Confirm carrier (this is the carrier's on-chain action)
    record.state = "carrier_confirmed"
    if (!request.carrierConfirmed) {
      ctx.logger.info(`[resurrection] Confirming carrier ${ctx.carrierId}...`)
      await ctx.soul.confirmCarrier(ctx.requestId)
    } else {
      ctx.logger.info(`[resurrection] Carrier already confirmed`)
    }

    // Step 4: Wait for readiness (guardian quorum + timelock for guardian-vote path)
    record.state = "waiting_readiness"
    ctx.logger.info(`[resurrection] Waiting for readiness (quorum + timelock)...`)
    await waitForReadiness(ctx)

    // Step 5: Download backup
    checkShutdown(ctx)
    record.state = "downloading_backup"
    ctx.logger.info(`[resurrection] Downloading backup for ${ctx.agentId}...`)

    const restoreResult = await autoRestore({
      agentId: ctx.agentId,
      targetDir: ctx.targetDir,
      soul: ctx.soul,
      ipfs: ctx.ipfs,
      cidResolver: ctx.cidResolver,
      privateKeyOrPassword: ctx.privateKeyOrPassword,
      isPassword: ctx.isPassword,
      logger: ctx.logger,
      notifyAgent: false,
    })

    record.filesRestored = restoreResult.recovery.filesRestored
    record.state = "restoring_state"

    // Step 6: Spawn agent
    checkShutdown(ctx)
    record.state = "spawning_agent"
    ctx.logger.info(`[resurrection] Spawning agent process...`)

    const doSpawn = ctx.overrides?.spawnAgent ?? spawnAgent
    const doHealth = ctx.overrides?.waitForHealthy ?? waitForHealthy
    const doStop = ctx.overrides?.stopAgent ?? stopAgent

    const spawnResult = doSpawn(ctx.spawnConfig, ctx.logger)
    record.agentPid = spawnResult.pid

    // Step 7: Health check
    record.state = "health_checking"
    ctx.logger.info(`[resurrection] Waiting for agent health check...`)

    const healthy = await doHealth(ctx.spawnConfig, ctx.logger, ctx.shutdownSignal)
    if (!healthy) {
      // Distinguish shutdown from actual health failure
      if (ctx.shutdownSignal?.aborted) {
        ctx.logger.warn("[resurrection] Health check interrupted by shutdown, stopping spawned process")
        doStop(spawnResult.pid, ctx.logger)
        record.agentPid = null
        throw new Error("Resurrection aborted: daemon shutting down")
      }
      ctx.logger.warn("[resurrection] Agent health check failed, stopping spawned process")
      doStop(spawnResult.pid, ctx.logger)
      record.agentPid = null
      throw new Error("Agent failed health check after spawn")
    }

    // Step 8: Complete resurrection on-chain
    checkShutdown(ctx)
    record.state = "resurrection_complete"
    ctx.logger.info(`[resurrection] Completing resurrection on-chain...`)
    await ctx.soul.completeResurrection(ctx.requestId)

    // Step 9: Send initial heartbeat (skip if shutting down — completeResurrection already succeeded)
    if (!ctx.shutdownSignal?.aborted) {
      ctx.logger.info(`[resurrection] Sending first heartbeat...`)
      try {
        await ctx.soul.heartbeat(ctx.agentId)
      } catch (error) {
        ctx.logger.warn(`[resurrection] Initial heartbeat failed (non-fatal): ${String(error)}`)
      }
    } else {
      ctx.logger.info(`[resurrection] Skipping heartbeat — daemon shutting down (resurrection already completed on-chain)`)
    }

    record.completedAt = Date.now()
    ctx.logger.info(
      `[resurrection] COMPLETE: Agent ${ctx.agentId} resurrected on carrier ${ctx.carrierId}, ` +
      `PID ${spawnResult.pid}, ${record.filesRestored} files restored`,
    )

    return {
      requestId: ctx.requestId,
      agentId: ctx.agentId,
      carrierId: ctx.carrierId,
      state: "resurrection_complete",
      filesRestored: record.filesRestored,
      totalBytes: restoreResult.recovery.totalBytes,
      agentPid: record.agentPid,
      error: null,
    }
  } catch (error) {
    record.state = "failed"
    record.error = String(error)
    record.completedAt = Date.now()
    ctx.logger.error(`[resurrection] FAILED for ${ctx.agentId}: ${String(error)}`)

    return {
      requestId: ctx.requestId,
      agentId: ctx.agentId,
      carrierId: ctx.carrierId,
      state: "failed",
      filesRestored: record.filesRestored,
      totalBytes: 0,
      agentPid: record.agentPid,
      error: String(error),
    }
  }
}

function checkShutdown(ctx: ResurrectionContext): void {
  if (ctx.shutdownSignal?.aborted) {
    throw new Error("Resurrection aborted: daemon shutting down")
  }
}

/**
 * Poll getResurrectionReadiness until canComplete is true.
 * For owner-key path this resolves immediately (no quorum/timelock).
 * For guardian-vote path this waits for 2/3 guardian approval + 12h timelock.
 */
async function waitForReadiness(ctx: ResurrectionContext): Promise<void> {
  const timeoutMs = ctx.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const pollMs = ctx.readinessPollMs ?? DEFAULT_READINESS_POLL_MS
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (ctx.shutdownSignal?.aborted) {
      throw new Error("Resurrection aborted: daemon shutting down")
    }

    const readiness = await ctx.soul.getResurrectionReadiness(ctx.requestId)

    if (!readiness.exists) {
      throw new Error(`Resurrection request ${ctx.requestId} no longer exists`)
    }

    if (readiness.canComplete) {
      ctx.logger.info(
        `[resurrection] Request ready: ${readiness.approvalCount}/${readiness.approvalThreshold} approvals, ` +
        `carrier=${readiness.carrierConfirmed}, offline=${readiness.offlineNow}`,
      )
      return
    }

    ctx.logger.info(
      `[resurrection] Not yet ready: ${readiness.approvalCount}/${readiness.approvalThreshold} approvals, ` +
      `carrier=${readiness.carrierConfirmed}, offline=${readiness.offlineNow}. ` +
      `Retrying in ${pollMs / 1000}s...`,
    )

    // Interruptible sleep: resolves on timeout or shutdown signal
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs)
      ctx.shutdownSignal?.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  throw new Error(
    `Resurrection readiness timed out after ${timeoutMs / 1000}s for request ${ctx.requestId}. ` +
    "Guardian approval quorum or timelock may not be satisfied.",
  )
}
