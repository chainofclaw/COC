/**
 * Shared sliding-window rate limiter per IP address.
 * Tracks request counts within a configurable time window.
 */
export class RateLimiter {
  private readonly windowMs: number
  private readonly maxRequests: number
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(windowMs = 60_000, maxRequests = 200) {
    this.windowMs = windowMs
    this.maxRequests = maxRequests
  }

  /**
   * Check if a request from the given IP should be allowed.
   * Returns true if allowed, false if rate-limited.
   */
  allow(ip: string): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(ip)

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs })
      return true
    }

    bucket.count++
    return bucket.count <= this.maxRequests
  }

  /** Periodically clean up expired buckets to prevent memory growth */
  cleanup(): void {
    const now = Date.now()
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip)
    }
  }
}
