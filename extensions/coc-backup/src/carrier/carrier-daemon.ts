// Carrier daemon: monitors for pending resurrection requests and executes them
//
// ROLE MODEL:
//   Guardians initiate + approve resurrections externally.
//   This daemon runs on the carrier node and:
//   1. Watches for pending requests targeting this carrier (via config or polling)
//   2. Confirms carrier on-chain
//   3. Waits for guardian quorum + timelock
//   4. Downloads backup, spawns agent, completes resurrection
//
// The daemon does NOT act as a guardian. It needs a key that is
// the carrier's registered owner EOA.

import { z } from "zod"
import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { CidResolver } from "../recovery/cid-resolver.ts"
import { OfflineMonitor } from "./offline-monitor.ts"
import { executeResurrectionFlow } from "./resurrection-flow.ts"
import type { ResurrectionResult } from "./resurrection-flow.ts"
import type { CarrierResurrectionRecord } from "./protocol.ts"

interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

// ── Config Schema ────────────────────────────────────────────────────────

export const CarrierDaemonConfigSchema = z.object({
  carrierId: z.string().describe("This carrier's registered ID (bytes32)"),
  watchedAgents: z.array(z.string()).default([]).describe("Agent IDs to monitor for offline status"),
  pendingRequestIds: z.array(z.object({
    requestId: z.string(),
    agentId: z.string(),
  })).default([]).describe("Pre-known pending resurrection requests targeting this carrier"),
  pollIntervalMs: z.number().default(60_000).describe("Offline/readiness check interval"),
  healthCheckTimeoutMs: z.number().default(120_000),
  healthCheckIntervalMs: z.number().default(5_000),
  readinessTimeoutMs: z.number().default(86_400_000).describe("Max time to wait for guardian quorum (default 24h)"),
  readinessPollMs: z.number().default(30_000).describe("Readiness polling interval"),
  maxConcurrentResurrections: z.number().default(1),
  agentEntryScript: z.string().describe("Path to OpenClaw entry script"),
  workDir: z.string().default("/tmp/coc-resurrections").describe("Working directory for restored agents"),
  privateKeyOrPassword: z.string().describe("Key for backup decryption"),
  isPassword: z.boolean().default(false),
})

export type CarrierDaemonConfig = z.infer<typeof CarrierDaemonConfigSchema>

// ── Request acceptance result ────────────────────────────────────────────

export type AddRequestResult =
  | { accepted: true }
  | { accepted: false; reason: "not_running" | "concurrency_limit" | "already_processing" }

// ── Daemon ───────────────────────────────────────────────────────────────

export class CarrierDaemon {
  private readonly config: CarrierDaemonConfig
  private readonly soul: SoulClient
  private readonly ipfs: IpfsClient
  private readonly cidResolver: CidResolver
  private readonly logger: Logger
  private readonly monitor: OfflineMonitor
  private readonly activeResurrections = new Map<string, Promise<ResurrectionResult>>()
  private readonly history: CarrierResurrectionRecord[] = []
  private running = false
  private _shutdownSignal: AbortController = new AbortController()

  constructor(
    config: CarrierDaemonConfig,
    soul: SoulClient,
    ipfs: IpfsClient,
    cidResolver: CidResolver,
    logger: Logger,
  ) {
    this.config = config
    this.soul = soul
    this.ipfs = ipfs
    this.cidResolver = cidResolver
    this.logger = logger

    this.monitor = new OfflineMonitor(soul, {
      pollIntervalMs: config.pollIntervalMs,
      watchedAgents: config.watchedAgents,
    }, logger)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this._shutdownSignal = new AbortController()
    this.monitor.start()

    for (const pending of this.config.pendingRequestIds) {
      this.addRequest(pending.requestId, pending.agentId)
    }

    this.logger.info(
      `CarrierDaemon started: carrier=${this.config.carrierId}, ` +
      `watching ${this.config.watchedAgents.length} agents, ` +
      `${this.config.pendingRequestIds.length} pending requests`,
    )
  }

  /** Gracefully stop: signal active flows to abort, then wait for them to drain */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this._shutdownSignal.abort()
    this.monitor.stop()

    // Wait for active resurrections to complete or abort (max 30s)
    if (this.activeResurrections.size > 0) {
      this.logger.info(`Waiting for ${this.activeResurrections.size} active resurrection(s) to drain...`)
      const drain = Promise.allSettled([...this.activeResurrections.values()])
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30_000)
      })
      await Promise.race([drain, timeout])
      if (timer !== undefined) clearTimeout(timer)
    }

    this.logger.info("CarrierDaemon stopped")
  }

  /**
   * Accept a new resurrection request for processing.
   * Returns whether the request was accepted or rejected (with reason).
   */
  addRequest(requestId: string, agentId: string): AddRequestResult {
    if (!this.running) {
      return { accepted: false, reason: "not_running" }
    }

    const key = `${agentId}:${requestId}`
    if (this.activeResurrections.has(key)) {
      this.logger.warn(`Request ${requestId} already being processed`)
      return { accepted: false, reason: "already_processing" }
    }

    if (this.activeResurrections.size >= this.config.maxConcurrentResurrections) {
      this.logger.warn(
        `Request ${requestId} rejected: max concurrent resurrections reached ` +
        `(${this.activeResurrections.size}/${this.config.maxConcurrentResurrections})`,
      )
      return { accepted: false, reason: "concurrency_limit" }
    }

    this.logger.info(`Accepted resurrection request ${requestId} for agent ${agentId}`)

    const startedAt = Date.now()
    const promise = this._executeRequest(requestId, agentId, startedAt)
    this.activeResurrections.set(key, promise)

    promise.finally(() => {
      this.activeResurrections.delete(key)
    })

    return { accepted: true }
  }

  addWatch(agentId: string): void {
    this.monitor.addWatch(agentId)
  }

  getStatus(): {
    running: boolean
    watchedAgents: string[]
    offlineAgents: string[]
    activeResurrections: string[]
    history: CarrierResurrectionRecord[]
  } {
    return {
      running: this.running,
      watchedAgents: this.monitor.getWatchedAgents(),
      offlineAgents: this.monitor.getOfflineAgents(),
      activeResurrections: [...this.activeResurrections.keys()],
      history: [...this.history],
    }
  }

  private async _executeRequest(
    requestId: string,
    agentId: string,
    startedAt: number,
  ): Promise<ResurrectionResult> {
    const { join } = await import("node:path")
    const { mkdir } = await import("node:fs/promises")

    const targetDir = join(this.config.workDir, agentId.slice(0, 16))
    await mkdir(targetDir, { recursive: true })

    const result = await executeResurrectionFlow({
      requestId,
      agentId,
      carrierId: this.config.carrierId,
      soul: this.soul,
      ipfs: this.ipfs,
      cidResolver: this.cidResolver,
      privateKeyOrPassword: this.config.privateKeyOrPassword,
      isPassword: this.config.isPassword,
      targetDir,
      spawnConfig: {
        dataDir: targetDir,
        agentId,
        entryScript: this.config.agentEntryScript,
        healthCheckTimeoutMs: this.config.healthCheckTimeoutMs,
        healthCheckIntervalMs: this.config.healthCheckIntervalMs,
      },
      readinessTimeoutMs: this.config.readinessTimeoutMs,
      readinessPollMs: this.config.readinessPollMs,
      logger: this.logger,
      shutdownSignal: this._shutdownSignal.signal,
    })

    this.history.push({
      requestId: result.requestId,
      agentId: result.agentId,
      state: result.state,
      startedAt,
      completedAt: Date.now(),
      error: result.error,
      filesRestored: result.filesRestored,
      agentPid: result.agentPid,
    })

    while (this.history.length > 100) {
      this.history.shift()
    }

    return result
  }
}
