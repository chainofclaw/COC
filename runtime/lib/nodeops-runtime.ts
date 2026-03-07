import { mkdirSync, writeFileSync } from "node:fs"
import { statfs } from "node:fs/promises"
import { totalmem } from "node:os"
import { join } from "node:path"
import { NodeOpsHooks } from "../../nodeops/agent-hooks.ts"
import type { NodeHealthSnapshot, NodeOpsPolicy } from "../../nodeops/policy-types.ts"
import { detectPolicyConflicts, loadPolicyFromFile, startPolicyHotReload, type PolicyHotReloadHandle } from "../../nodeops/policy-loader.ts"
import { createLogger } from "../../node/src/logger.ts"
import { requestJson } from "./http-client.ts"

const log = createLogger("nodeops-runtime")

interface NodeProbeResult {
  processUp: boolean
  peerCount: number
  latencyMs: number
}

interface RuntimeUsageSnapshot {
  cpuPct: number
  memPct: number
  diskPct: number
}

export interface RuntimeNodeOpsOptions {
  dataDir: string
  nodeUrl: string
  policyPath?: string
  hotReload?: boolean
  allowSelfRestart?: boolean
  actionDir?: string
  probeNode?: () => Promise<NodeProbeResult>
  usageProvider?: () => Promise<RuntimeUsageSnapshot>
  exitProcess?: (code: number) => void
}

export class RuntimeNodeOpsController {
  private readonly options: RuntimeNodeOpsOptions
  private hooks: NodeOpsHooks | null = null
  private reloadHandle: PolicyHotReloadHandle | null = null
  private latencySamples: number[] = []
  private lastCpuUsage = process.cpuUsage()
  private lastCpuTime = process.hrtime.bigint()

  constructor(options: RuntimeNodeOpsOptions) {
    this.options = options
  }

  get enabled(): boolean {
    return this.hooks !== null
  }

  async init(): Promise<void> {
    if (!this.options.policyPath) return
    this.installPolicy(loadPolicyFromFile(this.options.policyPath))
    if (this.options.hotReload) {
      this.reloadHandle = startPolicyHotReload(
        this.options.policyPath,
        (policy) => {
          this.installPolicy(policy)
          log.info("nodeops policy reloaded", { path: this.options.policyPath, profile: policy.profile })
        },
        (error) => {
          log.warn("nodeops policy reload failed", { path: this.options.policyPath, error: String(error) })
        },
      )
    }
  }

  async tick(nowMs = Date.now()): Promise<readonly { type: string; reason: string }[]> {
    if (!this.hooks) return []
    const [probe, usage] = await Promise.all([
      this.probeNode(),
      this.collectUsage(),
    ])
    const actions = await this.hooks.tick({
      nowMs: BigInt(nowMs),
      processUp: probe.processUp,
      cpuPct: usage.cpuPct,
      memPct: usage.memPct,
      diskPct: usage.diskPct,
      p95LatencyMs: this.recordLatency(probe.latencyMs),
      peerCount: probe.peerCount,
    })
    return actions
  }

  close(): void {
    this.reloadHandle?.close()
    this.reloadHandle = null
  }

  private installPolicy(policy: NodeOpsPolicy): void {
    const conflicts = detectPolicyConflicts(policy)
    for (const entry of conflicts) {
      log.warn("nodeops policy conflict detected", { profile: policy.profile, issue: entry })
    }

    const priorState = this.hooks?.getState() ?? {}
    this.hooks = new NodeOpsHooks(policy, {
      restartProcess: async () => this.handleAction("restart", { allowSelfRestart: this.options.allowSelfRestart === true }, () => {
        if (this.options.allowSelfRestart) {
          (this.options.exitProcess ?? process.exit)(75)
        }
      }),
      reconnectPeers: async (targetPeerCount) => this.handleAction("reconnect-peers", { targetPeerCount }),
      switchTransport: async (prefer) => this.handleAction("switch-transport", { prefer }),
      setRpcRateLimit: async (rps) => this.handleAction("set-rpc-rate-limit", { rps }),
      alert: async (message) => this.handleAction("alert", { message }),
      scheduleKeyRotation: async () => this.handleAction("schedule-key-rotation", {}),
    }, priorState)
  }

  private async probeNode(): Promise<NodeProbeResult> {
    if (this.options.probeNode) {
      return this.options.probeNode()
    }

    const startedAt = Date.now()
    try {
      const response = await requestJson(this.options.nodeUrl, "POST", {
        jsonrpc: "2.0",
        id: 1,
        method: "coc_getNetworkStats",
        params: [],
      })
      const latencyMs = Math.max(1, Date.now() - startedAt)
      const peerCount = Number(response.json?.result?.peerCount ?? 0)
      return { processUp: response.status === 200, peerCount: Number.isFinite(peerCount) ? peerCount : 0, latencyMs }
    } catch {
      return { processUp: false, peerCount: 0, latencyMs: Math.max(1, Date.now() - startedAt) }
    }
  }

  private async collectUsage(): Promise<RuntimeUsageSnapshot> {
    if (this.options.usageProvider) {
      return this.options.usageProvider()
    }

    return {
      cpuPct: this.computeCpuPct(),
      memPct: Math.min(100, Math.round((process.memoryUsage().rss / totalmem()) * 100)),
      diskPct: await this.computeDiskPct(),
    }
  }

  private computeCpuPct(): number {
    const nowUsage = process.cpuUsage()
    const nowTime = process.hrtime.bigint()
    const deltaMicros = Number((nowTime - this.lastCpuTime) / 1000n)
    const usedMicros = (nowUsage.user - this.lastCpuUsage.user) + (nowUsage.system - this.lastCpuUsage.system)
    this.lastCpuUsage = nowUsage
    this.lastCpuTime = nowTime
    if (deltaMicros <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((usedMicros / deltaMicros) * 100)))
  }

  private async computeDiskPct(): Promise<number> {
    try {
      const fsStats = await statfs(this.options.dataDir, { bigint: true })
      const total = fsStats.blocks * BigInt(fsStats.bsize)
      const free = fsStats.bavail * BigInt(fsStats.bsize)
      if (total <= 0n) return 0
      const used = total - free
      return Number((used * 100n) / total)
    } catch {
      return 0
    }
  }

  private recordLatency(latencyMs: number): number {
    this.latencySamples.push(latencyMs)
    if (this.latencySamples.length > 32) {
      this.latencySamples.shift()
    }
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) * 0.95)] ?? latencyMs
  }

  private async handleAction(
    action: string,
    payload: Record<string, unknown>,
    afterWrite?: () => void,
  ): Promise<void> {
    const actionDir = this.options.actionDir ?? join(this.options.dataDir, "nodeops-actions")
    mkdirSync(actionDir, { recursive: true })
    writeFileSync(
      join(actionDir, `${action}.json`),
      JSON.stringify({ action, payload, at: Date.now() }, null, 2),
      "utf8",
    )
    afterWrite?.()
  }
}
