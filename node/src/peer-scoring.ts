/**
 * Peer Scoring System
 *
 * Tracks peer behavior and assigns reputation scores:
 * - Successful block/tx relay increases score
 * - Invalid data, timeouts, and errors decrease score
 * - Peers below minimum threshold are banned temporarily
 * - Scores decay toward neutral over time
 */

export interface PeerScore {
  id: string
  url: string
  score: number
  successCount: number
  failureCount: number
  lastSeenMs: number
  bannedUntilMs: number
  banCount: number
}

export interface PeerScoringConfig {
  initialScore: number
  maxScore: number
  minScore: number
  banThreshold: number
  banDurationMs: number
  decayIntervalMs: number
  decayAmount: number
  successReward: number
  failurePenalty: number
  invalidDataPenalty: number
  timeoutPenalty: number
  maxPeers: number
}

const DEFAULT_CONFIG: PeerScoringConfig = {
  initialScore: 100,
  maxScore: 200,
  minScore: -100,
  banThreshold: 0,
  banDurationMs: 30 * 60 * 1000, // 30 minutes
  decayIntervalMs: 60 * 1000,    // 1 minute
  decayAmount: 1,
  successReward: 2,
  failurePenalty: 5,
  invalidDataPenalty: 20,
  timeoutPenalty: 10,
  maxPeers: 10_000,
}

export class PeerScoring {
  private readonly peers = new Map<string, PeerScore>()
  private readonly cfg: PeerScoringConfig
  private decayTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<PeerScoringConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Register a peer or update its URL
   */
  addPeer(id: string, url: string): void {
    if (this.peers.has(id)) {
      const peer = this.peers.get(id)!
      this.peers.set(id, { ...peer, url })
      return
    }
    // Evict lowest-score peer if at capacity
    if (this.peers.size >= this.cfg.maxPeers) {
      let worstId: string | null = null
      let worstScore = Infinity
      for (const [pid, p] of this.peers) {
        if (p.score < worstScore) { worstScore = p.score; worstId = pid }
      }
      if (worstId) this.peers.delete(worstId)
    }
    this.peers.set(id, {
      id,
      url,
      score: this.cfg.initialScore,
      successCount: 0,
      failureCount: 0,
      lastSeenMs: Date.now(),
      bannedUntilMs: 0,
      banCount: 0,
    })
  }

  /**
   * Record a successful interaction with a peer
   */
  recordSuccess(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.set(id, {
      ...peer,
      score: Math.min(peer.score + this.cfg.successReward, this.cfg.maxScore),
      successCount: peer.successCount + 1,
      lastSeenMs: Date.now(),
    })
  }

  /**
   * Record a general failure (connection error, timeout, etc.)
   */
  recordFailure(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    const newScore = Math.max(peer.score - this.cfg.failurePenalty, this.cfg.minScore)
    const shouldBan = newScore <= this.cfg.banThreshold
    const newBanCount = shouldBan ? peer.banCount + 1 : peer.banCount
    this.peers.set(id, {
      ...peer,
      score: newScore,
      failureCount: peer.failureCount + 1,
      banCount: newBanCount,
      bannedUntilMs: shouldBan
        ? Date.now() + this.exponentialBanMs(newBanCount)
        : peer.bannedUntilMs,
    })
  }

  /**
   * Record invalid data received from a peer (heavier penalty)
   */
  recordInvalidData(id: string): void {
    let peer = this.peers.get(id)
    if (!peer) {
      // Auto-register unknown peer so the penalty is recorded
      this.addPeer(id, id)
      peer = this.peers.get(id)!
    }
    const newScore = Math.max(peer.score - this.cfg.invalidDataPenalty, this.cfg.minScore)
    const shouldBan = newScore <= this.cfg.banThreshold
    const newBanCount = shouldBan ? peer.banCount + 1 : peer.banCount
    this.peers.set(id, {
      ...peer,
      score: newScore,
      failureCount: peer.failureCount + 1,
      banCount: newBanCount,
      bannedUntilMs: shouldBan
        ? Date.now() + this.exponentialBanMs(newBanCount)
        : peer.bannedUntilMs,
    })
  }

  /**
   * Record a timeout from a peer
   */
  recordTimeout(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    const newScore = Math.max(peer.score - this.cfg.timeoutPenalty, this.cfg.minScore)
    const shouldBan = newScore <= this.cfg.banThreshold
    const newBanCount = shouldBan ? peer.banCount + 1 : peer.banCount
    this.peers.set(id, {
      ...peer,
      score: newScore,
      failureCount: peer.failureCount + 1,
      banCount: newBanCount,
      bannedUntilMs: shouldBan
        ? Date.now() + this.exponentialBanMs(newBanCount)
        : peer.bannedUntilMs,
    })
  }

  /**
   * Check if a peer is currently banned
   */
  isBanned(id: string): boolean {
    const peer = this.peers.get(id)
    if (!peer) return false
    return peer.bannedUntilMs > Date.now()
  }

  /**
   * Get score for a specific peer
   */
  getScore(id: string): number {
    return this.peers.get(id)?.score ?? 0
  }

  /**
   * Get all active (non-banned) peers sorted by score descending
   */
  getActivePeers(): PeerScore[] {
    const now = Date.now()
    return [...this.peers.values()]
      .filter((p) => p.bannedUntilMs <= now)
      .sort((a, b) => b.score - a.score)
  }

  /**
   * Get all peers including banned ones
   */
  getAllPeers(): PeerScore[] {
    return [...this.peers.values()]
  }

  /**
   * Remove a peer from tracking
   */
  removePeer(id: string): void {
    this.peers.delete(id)
  }

  /**
   * Start the score decay timer
   */
  startDecay(): void {
    if (this.decayTimer) return
    this.decayTimer = setInterval(() => {
      this.applyDecay()
    }, this.cfg.decayIntervalMs)
  }

  /**
   * Stop the score decay timer
   */
  stopDecay(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
  }

  /**
   * Apply score decay toward the initial score.
   * Skip peers that are currently banned.
   */
  applyDecay(): void {
    const now = Date.now()
    for (const [id, peer] of this.peers) {
      // Don't decay score while peer is banned
      if (peer.bannedUntilMs > now) continue
      let newScore = peer.score
      if (newScore > this.cfg.initialScore) {
        newScore = Math.max(newScore - this.cfg.decayAmount, this.cfg.initialScore)
      } else if (newScore < this.cfg.initialScore) {
        newScore = Math.min(newScore + this.cfg.decayAmount, this.cfg.initialScore)
      }
      if (newScore !== peer.score) {
        this.peers.set(id, { ...peer, score: newScore })
      }
    }
  }

  /** Calculate exponential ban duration: baseBanMs * 2^min(banCount, 10), max 24h */
  private exponentialBanMs(banCount: number): number {
    const MAX_BAN_MS = 24 * 60 * 60 * 1000 // 24 hours
    const multiplier = Math.pow(2, Math.min(banCount - 1, 10))
    return Math.min(this.cfg.banDurationMs * multiplier, MAX_BAN_MS)
  }

  /**
   * Get summary statistics
   */
  stats(): { total: number; active: number; banned: number; avgScore: number } {
    const now = Date.now()
    const all = [...this.peers.values()]
    const active = all.filter((p) => p.bannedUntilMs <= now)
    const totalScore = all.reduce((sum, p) => sum + p.score, 0)
    return {
      total: all.length,
      active: active.length,
      banned: all.length - active.length,
      avgScore: all.length > 0 ? Math.round(totalScore / all.length) : 0,
    }
  }
}
