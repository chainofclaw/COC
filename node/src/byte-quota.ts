/**
 * Byte-counting sliding-window quota tracker.
 *
 * Pair with {@link RateLimiter} (which counts requests) for endpoints
 * where the per-request cost is the upload size, not the call count.
 * Tracks bytes per key (typically IP) AND a global rollup so anonymous
 * traffic can't fill disk by rotating source IPs.
 *
 * Usage pattern for /api/v0/add anonymous tier (#9):
 *   1. `tryReserve(ip, declaredBytes)` at route entry — fast reject
 *      requests whose Content-Length already exceeds budget. Returns
 *      `{ ok: true, commit, refund }` on success.
 *   2. On successful upload, `commit(actualBytes)` — adjusts the bucket
 *      to match real bytes consumed (Content-Length may have lied).
 *   3. On failure / no body, `refund()` — releases the reservation.
 *
 * Reservations stay charged until commit/refund OR until the window
 * expires (whichever happens first), so callers that forget to commit
 * still see their charge auto-release at window roll-over.
 */
export interface QuotaReservation {
  /** Adjust the charge to the actual bytes consumed (vs declared). */
  commit(actualBytes: number): void
  /** Release the reservation (e.g. upload failed before any bytes consumed). */
  refund(): void
}

export interface QuotaCheckResult {
  ok: boolean
  /** Which limit was hit. Undefined on success. */
  reason?: "per-key" | "global"
  /** Bytes remaining in the more-restrictive of the two budgets. */
  remaining?: number
  /** Active reservation handle. Only present when `ok: true`. */
  reservation?: QuotaReservation
}

export class ByteQuota {
  private readonly windowMs: number
  private readonly perKeyMax: number
  private readonly globalMax: number
  private readonly maxKeys: number
  private readonly buckets = new Map<string, { used: number; resetAt: number }>()
  private globalUsed = 0
  private globalResetAt = 0

  constructor(opts: {
    windowMs?: number
    perKeyMax: number
    globalMax: number
    maxKeys?: number
  }) {
    this.windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000
    this.perKeyMax = opts.perKeyMax
    this.globalMax = opts.globalMax
    this.maxKeys = opts.maxKeys ?? 100_000
  }

  /**
   * Reserve `declaredBytes` against the key + global budget. Returns
   * `ok: false` with `reason` populated when either limit would be
   * exceeded. Test runners can bypass via COC_IPFS_QUOTA_DISABLED=1.
   */
  tryReserve(key: string, declaredBytes: number): QuotaCheckResult {
    if (process.env.COC_IPFS_QUOTA_DISABLED === "1") {
      return { ok: true, reservation: { commit: () => {}, refund: () => {} } }
    }
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
      return { ok: false, reason: "per-key", remaining: 0 }
    }
    const now = Date.now()
    this.rollWindows(now)

    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        this.cleanup(now)
        if (this.buckets.size >= this.maxKeys) {
          // Out of bucket slots: treat as per-key denial so a flood of
          // distinct keys can't displace existing reservations.
          return { ok: false, reason: "per-key", remaining: 0 }
        }
      }
      bucket = { used: 0, resetAt: now + this.windowMs }
      this.buckets.set(key, bucket)
    }

    const perKeyRemaining = this.perKeyMax - bucket.used
    if (declaredBytes > perKeyRemaining) {
      return { ok: false, reason: "per-key", remaining: Math.max(0, perKeyRemaining) }
    }
    const globalRemaining = this.globalMax - this.globalUsed
    if (declaredBytes > globalRemaining) {
      return { ok: false, reason: "global", remaining: Math.max(0, globalRemaining) }
    }

    bucket.used += declaredBytes
    this.globalUsed += declaredBytes
    let active = true
    let charged = declaredBytes

    const reservation: QuotaReservation = {
      commit: (actualBytes: number) => {
        if (!active) return
        active = false
        const delta = Math.max(0, Math.floor(actualBytes)) - charged
        if (delta === 0) return
        bucket!.used = Math.max(0, bucket!.used + delta)
        this.globalUsed = Math.max(0, this.globalUsed + delta)
      },
      refund: () => {
        if (!active) return
        active = false
        bucket!.used = Math.max(0, bucket!.used - charged)
        this.globalUsed = Math.max(0, this.globalUsed - charged)
      },
    }

    return { ok: true, reservation }
  }

  /** Test/observability hook — current per-key used bytes (0 if unknown). */
  used(key: string): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return 0
    if (Date.now() >= bucket.resetAt) return 0
    return bucket.used
  }

  /** Test/observability hook — current global used bytes. */
  globalBytes(): number {
    if (Date.now() >= this.globalResetAt) return 0
    return this.globalUsed
  }

  private rollWindows(now: number): void {
    if (now >= this.globalResetAt) {
      this.globalUsed = 0
      this.globalResetAt = now + this.windowMs
    }
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
  }

  private cleanup(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
  }
}
