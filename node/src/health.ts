/**
 * Health Check & Readiness Probes
 *
 * Provides /health and /ready endpoints for load balancers and
 * orchestration systems, plus a config validator.
 */

import type { IChainEngine } from "./chain-engine-types.ts"

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy"
  uptime: number
  version: string
  chainId: number
  nodeId: string
  latestBlock: bigint
  peerCount: number
  mempoolSize: number
  checks: Record<string, CheckResult>
}

export interface CheckResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export interface HealthCheckerConfig {
  version: string
  chainId: number
  nodeId: string
  maxBlockAge: number       // Max seconds since last block before degraded
  minPeers: number          // Minimum peers for healthy status
}

const DEFAULT_CONFIG: HealthCheckerConfig = {
  version: "0.1.0",
  chainId: 18780,
  nodeId: "node-1",
  maxBlockAge: 60,
  minPeers: 0,
}

export class HealthChecker {
  private readonly config: HealthCheckerConfig
  private readonly startTime: number

  constructor(config?: Partial<HealthCheckerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.startTime = Date.now()
  }

  /**
   * Run all health checks and return status.
   */
  async check(
    engine: IChainEngine,
    opts?: { peerCount?: number },
  ): Promise<HealthStatus> {
    const checks: Record<string, CheckResult> = {}

    // Chain engine check
    const chainStart = performance.now()
    try {
      const block = await Promise.resolve(engine.getBlockByNumber(engine.height - 1n))
      const chainLatency = performance.now() - chainStart
      checks.chain = {
        ok: block !== null,
        message: block ? `latest block #${engine.height - 1n}` : "no blocks",
        latencyMs: Math.round(chainLatency),
      }
    } catch (err) {
      checks.chain = {
        ok: false,
        message: `chain check failed: ${err}`,
        latencyMs: Math.round(performance.now() - chainStart),
      }
    }

    // Block freshness check
    let block: Awaited<ReturnType<typeof engine.getBlockByNumber>> = null
    try {
      block = await Promise.resolve(engine.getBlockByNumber(engine.height - 1n))
    } catch {
      // If chain is already failed, skip freshness check
    }
    if (block) {
      const ageSec = Math.floor(Date.now() / 1000) - block.timestamp
      checks.blockFreshness = {
        ok: ageSec < this.config.maxBlockAge,
        message: ageSec < this.config.maxBlockAge
          ? `block age ${ageSec}s (max ${this.config.maxBlockAge}s)`
          : `stale: block age ${ageSec}s exceeds ${this.config.maxBlockAge}s`,
      }
    } else {
      checks.blockFreshness = { ok: true, message: "no blocks yet" }
    }

    // Peer check
    const peerCount = opts?.peerCount ?? 0
    checks.peers = {
      ok: peerCount >= this.config.minPeers,
      message: `${peerCount} peers (min ${this.config.minPeers})`,
    }

    // Mempool check
    const mempoolSize = engine.mempool.size()
    checks.mempool = {
      ok: true,
      message: `${mempoolSize} pending txs`,
    }

    // Determine overall status
    const allOk = Object.values(checks).every((c) => c.ok)
    const anyFailed = Object.values(checks).some((c) => !c.ok)

    let status: "healthy" | "degraded" | "unhealthy"
    if (allOk) {
      status = "healthy"
    } else if (checks.chain?.ok) {
      status = "degraded"
    } else {
      status = "unhealthy"
    }

    return {
      status,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.config.version,
      chainId: this.config.chainId,
      nodeId: this.config.nodeId,
      latestBlock: engine.height - 1n,
      peerCount,
      mempoolSize,
      checks,
    }
  }
}

/**
 * Validate node configuration and return any issues found.
 */
export interface ConfigIssue {
  field: string
  severity: "error" | "warning"
  message: string
}

export function validateConfig(config: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  // Required fields
  if (!config.nodeId || typeof config.nodeId !== "string") {
    issues.push({ field: "nodeId", severity: "error", message: "nodeId is required" })
  }

  if (!config.chainId || typeof config.chainId !== "number" || config.chainId <= 0) {
    issues.push({ field: "chainId", severity: "error", message: "chainId must be a positive number" })
  }

  // Port validation
  const portFields = ["rpcPort", "wsPort", "p2pPort", "ipfsPort"]
  for (const field of portFields) {
    const port = config[field]
    if (port !== undefined) {
      if (typeof port !== "number" || port < 1 || port > 65535) {
        issues.push({ field, severity: "error", message: `${field} must be 1-65535` })
      }
      if (typeof port === "number" && port < 1024) {
        issues.push({ field, severity: "warning", message: `${field} uses privileged port ${port}` })
      }
    }
  }

  // Validators
  const validators = config.validators
  if (!Array.isArray(validators) || validators.length === 0) {
    issues.push({ field: "validators", severity: "warning", message: "no validators configured" })
  }

  // Block time
  const blockTimeMs = config.blockTimeMs
  if (typeof blockTimeMs === "number") {
    if (blockTimeMs < 100) {
      issues.push({ field: "blockTimeMs", severity: "warning", message: "block time < 100ms may cause issues" })
    }
    if (blockTimeMs > 60000) {
      issues.push({ field: "blockTimeMs", severity: "warning", message: "block time > 60s is unusually slow" })
    }
  }

  // Finality depth
  const finalityDepth = config.finalityDepth
  if (typeof finalityDepth === "number" && finalityDepth < 1) {
    issues.push({ field: "finalityDepth", severity: "error", message: "finalityDepth must be >= 1" })
  }

  // Max tx per block
  const maxTxPerBlock = config.maxTxPerBlock
  if (typeof maxTxPerBlock === "number" && maxTxPerBlock < 1) {
    issues.push({ field: "maxTxPerBlock", severity: "error", message: "maxTxPerBlock must be >= 1" })
  }

  return issues
}

/**
 * Simple token bucket rate limiter for RPC endpoints.
 */
export class RateLimiter {
  private readonly maxTokens: number
  private readonly refillRatePerSec: number
  private readonly buckets: Map<string, { tokens: number; lastRefill: number }> = new Map()

  constructor(maxTokens = 100, refillRatePerSec = 10) {
    this.maxTokens = maxTokens
    this.refillRatePerSec = refillRatePerSec
  }

  /**
   * Check if a request from the given key is allowed.
   */
  allow(key: string): boolean {
    const now = Date.now()
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now }
      this.buckets.set(key, bucket)
    }

    // Refill tokens
    const elapsed = (now - bucket.lastRefill) / 1000
    const refill = elapsed * this.refillRatePerSec
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill)
    bucket.lastRefill = now

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return true
    }

    return false
  }

  /**
   * Get remaining tokens for a key.
   */
  remaining(key: string): number {
    const bucket = this.buckets.get(key)
    return bucket ? Math.floor(bucket.tokens) : this.maxTokens
  }

  /**
   * Reset rate limiter for a key.
   */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  /**
   * Clean up stale buckets.
   */
  cleanup(olderThanMs = 3600000): void {
    const threshold = Date.now() - olderThanMs
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < threshold) {
        this.buckets.delete(key)
      }
    }
  }
}
