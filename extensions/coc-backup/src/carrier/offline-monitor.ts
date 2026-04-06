// Offline monitor: watches registered agents for offline status
// Triggers resurrection flow when an agent's heartbeat expires

import type { SoulClient } from "../soul-client.ts"

interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface OfflineMonitorConfig {
  pollIntervalMs: number
  watchedAgents: string[]
}

export type OfflineHandler = (agentId: string) => void

/**
 * Monitors registered agents for offline transitions.
 * Polls SoulRegistry.isOffline() at a configurable interval.
 * Only emits events on online→offline transitions (debounced).
 */
export class OfflineMonitor {
  private readonly soul: SoulClient
  private readonly logger: Logger
  private readonly config: OfflineMonitorConfig
  private readonly watched = new Set<string>()
  private readonly knownOffline = new Set<string>()
  private readonly handlers: OfflineHandler[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(soul: SoulClient, config: OfflineMonitorConfig, logger: Logger) {
    this.soul = soul
    this.config = config
    this.logger = logger

    for (const agentId of config.watchedAgents) {
      this.watched.add(agentId)
    }
  }

  addWatch(agentId: string): void {
    this.watched.add(agentId)
  }

  removeWatch(agentId: string): void {
    this.watched.delete(agentId)
    this.knownOffline.delete(agentId)
  }

  onOffline(handler: OfflineHandler): void {
    this.handlers.push(handler)
  }

  start(): void {
    if (this.timer) return
    if (this.watched.size === 0) {
      this.logger.warn("OfflineMonitor started with no watched agents")
    }

    this.logger.info(
      `OfflineMonitor started: watching ${this.watched.size} agents, poll every ${this.config.pollIntervalMs}ms`,
    )

    this.timer = setInterval(() => {
      this._poll().catch((error) => {
        this.logger.error(`OfflineMonitor poll error: ${String(error)}`)
      })
    }, this.config.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getWatchedAgents(): string[] {
    return [...this.watched]
  }

  getOfflineAgents(): string[] {
    return [...this.knownOffline]
  }

  private async _poll(): Promise<void> {
    for (const agentId of this.watched) {
      try {
        // Check if resurrection is configured for this agent
        const resConfig = await this.soul.getResurrectionConfig(agentId)
        if (!resConfig.configured) continue

        const isOffline = await this.soul.isOffline(agentId)

        if (isOffline && !this.knownOffline.has(agentId)) {
          // Online → Offline transition detected
          this.knownOffline.add(agentId)
          this.logger.info(`Agent ${agentId} detected OFFLINE`)
          for (const handler of this.handlers) {
            try {
              handler(agentId)
            } catch (error) {
              this.logger.error(`Offline handler error for ${agentId}: ${String(error)}`)
            }
          }
        } else if (!isOffline && this.knownOffline.has(agentId)) {
          // Offline → Online transition
          this.knownOffline.delete(agentId)
          this.logger.info(`Agent ${agentId} back ONLINE`)
        }
      } catch (error) {
        this.logger.warn(`Failed to check agent ${agentId}: ${String(error)}`)
      }
    }
  }
}
